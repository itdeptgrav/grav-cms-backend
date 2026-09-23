// services/industrialEngineering/ieMethodStudy.service.js
//
// THE DRAFT METHOD STUDY (Chunk 4A).
//
// Four things happen here: open (or resume) a study for a bulletin row, list a
// row's studies, read one, and edit its draft. Nothing submits, returns,
// approves or rejects — Chunk 4B owns the lifecycle — and nothing writes back
// to the bulletin or to the operation library. A study is evidence; applying
// its number to a row is a decision somebody makes later, through a door that
// does not exist yet.
//
// ── THE SNAPSHOT COMES FROM THE ROW, NOT THE LIBRARY ────────────────────────
// A study captures `ieOperationId`, its revision, code, name and machine type
// from the BULLETIN ROW — which itself preserved them from when the row was
// authored (Chunk 3A). Reading the live library here would let a study claim it
// timed a revision of the operation that did not exist on the day it was timed.
// Nothing in this file ever refreshes those five fields.
//
// ── AND THE STUDY IS NEVER REBASED ──────────────────────────────────────────
// The bulletin moves underneath studies constantly: rows are reordered,
// re-noted, re-timed, replaced and removed. So every read derives how the study
// now relates to the file:
//
//   CURRENT            the row is there and still names the same operation
//                      revision. Reorders, note edits and proposed-SAM changes
//                      land here — none of them changes what was timed.
//   OPERATION_CHANGED  the row now names a different operation (or a different
//                      revision of one). The study stays readable as the
//                      evidence for what it did time, and opening a study for
//                      the row again starts a NEW draft for the new operation.
//   ROW_REMOVED        the row is gone from the bulletin. Still readable, for
//                      the same reason.
//
// Only a CURRENT study may be edited. A stale one is refused with a typed
// conflict rather than silently rebased onto an operation nobody timed, and
// rather than deleted — deleting it is how the reason for a standard time
// disappears a year after anybody could reconstruct it.
//
// ── CHUNK 4B: SUBMIT, RETURN, APPROVE ──────────────────────────────────────
// A completed draft is SUBMITTED, which freezes everything about it — the
// cycles, the rating, the normal time and the exact published allowance policy
// effective on the day it was studied — calculates the standard time, and moves
// the study to IN_REVIEW. Somebody ELSE then returns it with a reason, or
// approves it. Every attempt stays as evidence, including the returned ones.
//
// Three rules carry that:
//
//   · MAKER-CHECKER on actor IDS. The submitter cannot return or approve their
//     own submission, and an IE owner or platform administrator is refused on
//     the same terms — a grant says what somebody may do, not who they are.
//   · ONE DOCUMENT, ONE WRITE. Study status, submission status, revision and
//     audit event move in a single conditional update, so there is never a
//     moment where a study is approved and its submission is not.
//   · NOTHING LEAVES. An approved standard time is not written into the
//     bulletin row and is not released to Production, Planning or Costing.
//     Applying it is a decision for a later chunk, through a door that does not
//     exist yet.
//
// ── COMPANY, ALWAYS, AND WITHOUT DISCLOSURE ─────────────────────────────────
// Every lookup carries `companyId`. A foreign company's file, row or study is
// answered exactly as one that never existed: same code, same message, same
// details. Nothing about its style, operation, revision or applicability
// reaches a caller who cannot prove the company.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const { fail } = require("../storePurchase/errors");
const { calculateMethodStudy, round4 } = require("./methodStudyCalculation");
const { calculateStandardTime } = require("./standardTimeCalculation");
const ieAllowancePolicy = require("./ieAllowancePolicy.service");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");

const { LIMITS, SUBMISSION_STATUS: SUB_STATUS_LIST } = IeMethodStudy;

const STUDY_STATUS = Object.freeze({ DRAFT: "DRAFT", IN_REVIEW: "IN_REVIEW", APPROVED: "APPROVED" });
const SUBMISSION_STATUS = Object.freeze({ IN_REVIEW: "IN_REVIEW", RETURNED: "RETURNED", APPROVED: "APPROVED" });
const SOURCE = Object.freeze({ CALCULATED: "CALCULATED", MANUAL_OVERRIDE: "MANUAL_OVERRIDE" });

/* Bodies for the three lifecycle actions. Each is tiny on purpose: a decision
   is a decision, not an opportunity to edit the thing being decided. */
const SUBMIT_FIELDS = Object.freeze(["expectedRevision", "manualStandardTimeMinutes", "overrideReason"]);
const RETURN_FIELDS = Object.freeze(["expectedRevision", "reason"]);
const APPROVE_FIELDS = Object.freeze(["expectedRevision", "note"]);

/** Why a study cannot be submitted yet. One code per missing requirement. */
const READINESS = Object.freeze({
  NOT_DRAFT: "IE_STUDY_NOT_DRAFT",
  NOT_CURRENT: "IE_STUDY_NOT_CURRENT",
  DATE_MISSING: "IE_STUDY_DATE_MISSING",
  LOCATION_MISSING: "IE_STUDY_LOCATION_MISSING",
  METHOD_NOTE_MISSING: "IE_STUDY_METHOD_NOTE_MISSING",
  NO_INCLUDED_OBSERVATION: "IE_STUDY_NO_INCLUDED_OBSERVATION",
  RATING_MISSING: "IE_STUDY_RATING_MISSING",
  CALCULATION_INCOMPLETE: "IE_STUDY_CALCULATION_INCOMPLETE",
  NO_EFFECTIVE_POLICY: "IE_STUDY_NO_EFFECTIVE_ALLOWANCE_POLICY",
  ALREADY_IN_REVIEW: "IE_STUDY_SUBMISSION_IN_REVIEW",
  SUBMISSION_LIMIT: "IE_STUDY_SUBMISSION_LIMIT_REACHED",
});

const APPLICABILITY = Object.freeze({
  CURRENT: "CURRENT",
  OPERATION_CHANGED: "OPERATION_CHANGED",
  ROW_REMOVED: "ROW_REMOVED",
});

/* ── THE EDITABLE SURFACE ─────────────────────────────────────────────────
   What an engineer records. Everything else about a study — whose company it
   is, which row and operation it timed, its status, revision, calculations and
   history — is the server's, and is refused by name below. */
const STUDY_FIELDS = Object.freeze([
  "studiedAt", "location", "methodNote", "evidenceNote", "ratingPercent", "observations",
]);
const PATCH_FIELDS = Object.freeze([...STUDY_FIELDS, "expectedRevision"]);
const OBSERVATION_FIELDS = Object.freeze([
  "observationId", "durationSeconds", "included", "exclusionReason", "note",
]);

const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  ieStyleFileId: "which engineering file it belongs to",
  sampleStyleId: "which style it belongs to",
  bulletinRowId: "which bulletin row it timed",
  ieOperationId: "the operation — that is captured from the bulletin row",
  ieOperationRevision: "the operation revision, which is captured from the bulletin row",
  operationCode: "the operation's code, which is captured from the bulletin row",
  operationName: "the operation's name, which is captured from the bulletin row",
  machineType: "the machine type, which is captured from the bulletin row",
  status: "its own status — submit and approve are a later chunk",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  result: "the calculation, which the server derives from the observations",
  history: "its own audit trail",
  normalTimeSeconds: "a calculated time — the server derives it from the cycles and the rating",
  normalTimeMinutes: "a calculated time — the server derives it from the cycles and the rating",
  averageObservedSeconds: "a calculated time — the server derives it from the cycles",
  standardTimeMinutes: "a standard time — it is calculated at submission from the published allowance policy",
  standardTimeSeconds: "a standard time — it is calculated at submission from the published allowance policy",
  standardTimeSource: "where its standard time came from, which the submission records",
  allowancePercent: "an allowance — allowances are a company policy, published by a second person",
  allowancePolicy: "an allowance policy — the server resolves the published one effective on the study date",
  submissions: "its own submission history",
  currentSubmissionId: "which submission is in review",
  approvedSubmissionId: "which submission was approved",
  approved: "its own approval",
  workerName: "the operator's name. A method study times an OPERATION, not a person",
  employeeId: "an employee id. A method study times an OPERATION, not a person",
  operatorId: "an operator id. A method study times an OPERATION, not a person",
  designation: "a designation. Pay grades are payroll's, and are not evidence of a time",
  wageRate: "a wage. IE owns the time; payroll owns the money",
});

const OBSERVATION_REFUSED = Object.freeze({
  sequence: "its own position — the order of `observations` is the cycle order",
  workerName: "the operator's name. A cycle records a time, not a person",
  employeeId: "an employee id. A cycle records a time, not a person",
  ratingPercent: "a rating of its own — the rating is judged for the study, not per cycle",
});

/* ═══ SMALL HELPERS ════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/** One indistinguishable refusal for absent, foreign and malformed alike. */
const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");
const rowNotFound = () => fail("IE_BULLETIN_ROW_NOT_FOUND", "That bulletin row was not found.");
const studyNotFound = () => fail("IE_METHOD_STUDY_NOT_FOUND", "That method study was not found.");

/** The active-study index refusing a second DRAFT/IN_REVIEW for one operation. */
const isDuplicateActiveStudy = (err) =>
  err?.code === 11000 || /E11000|duplicate key/i.test(str(err?.message));

const mintObservationId = () => `obs_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `mse_${crypto.randomBytes(9).toString("hex")}`;

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

const event = (type, { actor, studyRevision, changed = [], summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  studyRevision,
  changed,
  summary: summary.slice(0, LIMITS.SUMMARY),
});

/* ═══ OWNERSHIP AND APPLICABILITY ══════════════════════════════════════════ */

/**
 * The engineering file, proved to be this company's.
 *
 * A local, company-scoped lookup rather than a call into the accepted Chunk 3A
 * service: this chunk adds no reason to change that file's exported surface,
 * and the lookup it needs is one line of the same shape every IE read uses.
 */
async function loadOwnedFile(ctx, fileId) {
  assertContext(ctx);
  if (!isId(fileId)) throw fileNotFound();
  const doc = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
    .select("_id companyId sampleStyleId bulletin.rows").lean();
  if (!doc) throw fileNotFound();
  return doc;
}

const rowOf = (file, rowId) => (file.bulletin?.rows || []).find((r) => r.rowId === str(rowId)) || null;

/**
 * How this study relates to the bulletin as it stands now.
 *
 * The comparison is the ROW ID plus the captured operation identity — its id
 * AND its revision. Everything else about a row is free to move: its position,
 * its note, its proposed SAM. None of those changes what was timed, so none of
 * them makes a study stale. Replacing the operation does, and so does the row
 * disappearing.
 */
function applicabilityOf(study, file) {
  const row = rowOf(file, study.bulletinRowId);
  if (!row) return APPLICABILITY.ROW_REMOVED;
  const sameOperation = String(row.ieOperationId) === String(study.ieOperationId)
    && Number(row.ieOperationRevision) === Number(study.ieOperationRevision);
  return sameOperation ? APPLICABILITY.CURRENT : APPLICABILITY.OPERATION_CHANGED;
}

/* ═══ THE PUBLISHED SHAPE ══════════════════════════════════════════════════ */

const publishObservation = (o) => ({
  observationId: o.observationId,
  sequence: o.sequence,
  durationSeconds: o.durationSeconds,
  included: o.included !== false,
  exclusionReason: o.exclusionReason || "",
  note: o.note || "",
});

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  studyRevision: e.studyRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
});

/** One frozen submission, in full — what was timed and what was decided. */
function publishSubmission(sub) {
  return {
    submissionId: sub.submissionId,
    sourceStudyRevision: sub.sourceStudyRevision,
    status: sub.status,
    studiedAt: sub.studiedAt ? new Date(sub.studiedAt).toISOString() : null,
    location: sub.location || "",
    methodNote: sub.methodNote || "",
    evidenceNote: sub.evidenceNote || "",
    ratingPercent: sub.ratingPercent ?? null,
    observations: (sub.observations || []).map(publishObservation),
    result: {
      includedCycleCount: sub.result?.includedCycleCount ?? 0,
      excludedCycleCount: sub.result?.excludedCycleCount ?? 0,
      averageObservedSeconds: sub.result?.averageObservedSeconds ?? null,
      ratingPercent: sub.result?.ratingPercent ?? null,
      normalTimeSeconds: sub.result?.normalTimeSeconds ?? null,
      normalTimeMinutes: sub.result?.normalTimeMinutes ?? null,
      calculationComplete: Boolean(sub.result?.calculationComplete),
    },
    allowancePolicy: {
      policyId: sub.allowancePolicy?.policyId ? String(sub.allowancePolicy.policyId) : null,
      policyRevision: sub.allowancePolicy?.policyRevision ?? null,
      name: sub.allowancePolicy?.name || "",
      effectiveFrom: ieAllowancePolicy.asDay(sub.allowancePolicy?.effectiveFrom),
      categories: (sub.allowancePolicy?.categories || []).map((c) => ({
        categoryId: c.categoryId, sequence: c.sequence, code: c.code,
        name: c.name || "", percent: c.percent, note: c.note || "",
      })),
      totalAllowancePercent: sub.allowancePolicy?.totalAllowancePercent ?? null,
    },
    /* BOTH figures, always. An override never hides what the calculation said. */
    calculatedStandardTimeSeconds: sub.calculatedStandardTimeSeconds ?? null,
    calculatedStandardTimeMinutes: sub.calculatedStandardTimeMinutes ?? null,
    manualStandardTimeMinutes: sub.manualStandardTimeMinutes ?? null,
    overrideReason: sub.overrideReason || "",
    standardTimeSource: sub.standardTimeSource || SOURCE.CALCULATED,
    standardTimeSeconds: sub.standardTimeSeconds ?? null,
    standardTimeMinutes: sub.standardTimeMinutes ?? null,
    isOverridden: (sub.standardTimeSource || SOURCE.CALCULATED) === SOURCE.MANUAL_OVERRIDE,
    submittedByName: sub.submittedByName || "",
    submittedAt: sub.submittedAt ? new Date(sub.submittedAt).toISOString() : null,
    reviewedByName: sub.reviewedByName || "",
    reviewedAt: sub.reviewedAt ? new Date(sub.reviewedAt).toISOString() : null,
    reviewNote: sub.reviewNote || "",
  };
}

/** The short form a study read carries for its open and approved attempts. */
const summariseSubmission = (sub) => (sub ? {
  submissionId: sub.submissionId,
  status: sub.status,
  sourceStudyRevision: sub.sourceStudyRevision,
  standardTimeSource: sub.standardTimeSource || SOURCE.CALCULATED,
  standardTimeMinutes: sub.standardTimeMinutes ?? null,
  calculatedStandardTimeMinutes: sub.calculatedStandardTimeMinutes ?? null,
  manualStandardTimeMinutes: sub.manualStandardTimeMinutes ?? null,
  isOverridden: (sub.standardTimeSource || SOURCE.CALCULATED) === SOURCE.MANUAL_OVERRIDE,
  totalAllowancePercent: sub.allowancePolicy?.totalAllowancePercent ?? null,
  allowancePolicyId: sub.allowancePolicy?.policyId ? String(sub.allowancePolicy.policyId) : null,
  submittedByName: sub.submittedByName || "",
  submittedAt: sub.submittedAt ? new Date(sub.submittedAt).toISOString() : null,
  reviewedByName: sub.reviewedByName || "",
  reviewedAt: sub.reviewedAt ? new Date(sub.reviewedAt).toISOString() : null,
  reviewNote: sub.reviewNote || "",
} : null);

const submissionById = (doc, id) => (doc.submissions || []).find((s) => s.submissionId === id) || null;

/**
 * The submission AWAITING A DECISION, if there is one.
 *
 * `currentSubmissionId` is cleared by a return and deliberately left in place by
 * an approval (the approved attempt is still the one the study was decided on),
 * so "current" is defined here by the submission's own status rather than by the
 * pointer. A screen asking "is something waiting for a reviewer" gets null on an
 * approved study, which is the truthful answer; the approved attempt is
 * published beside it as `approvedSubmission`.
 */
function openSubmissionOf(doc) {
  const pointed = submissionById(doc, doc.currentSubmissionId);
  return pointed && pointed.status === SUBMISSION_STATUS.IN_REVIEW ? pointed : null;
}

const gap = (code, action, message, extra = {}) => ({
  code, owner: "INDUSTRIAL_ENGINEERING", action, message, ...extra,
});

/**
 * WHAT IS MISSING BEFORE THIS STUDY CAN BE SUBMITTED — all of it, at once.
 *
 * Every requirement gets its own code and its own sentence. A single
 * "incomplete" message sends somebody round the loop one field at a time, and
 * the one requirement they cannot see from the form — that no allowance policy
 * is published for the day they timed the job — is the one they would never
 * guess.
 *
 * `policyFor` is injected so a list of studies resolves each date's policy once
 * rather than per row.
 */
async function submissionReadiness(doc, { applicability, policyFor }) {
  const gaps = [];

  if (doc.status !== STUDY_STATUS.DRAFT) {
    gaps.push(gap(READINESS.NOT_DRAFT, doc.status === STUDY_STATUS.APPROVED ? "OPEN_NEW_STUDY" : "AWAIT_REVIEW",
      doc.status === STUDY_STATUS.APPROVED
        ? "This study is approved. Open a new study to re-time the operation."
        : "This study is already with a reviewer."));
  }
  if (applicability !== APPLICABILITY.CURRENT) {
    gaps.push(gap(READINESS.NOT_CURRENT, "OPEN_NEW_STUDY",
      applicability === APPLICABILITY.ROW_REMOVED
        ? "The bulletin row this study was timed against has been removed."
        : "The bulletin row now names a different operation."));
  }
  if (!doc.studiedAt) gaps.push(gap(READINESS.DATE_MISSING, "RECORD_STUDY_DATE", "Record the date the study was made."));
  if (!str(doc.location)) gaps.push(gap(READINESS.LOCATION_MISSING, "RECORD_LOCATION", "Record where the study was made."));
  if (!str(doc.methodNote)) gaps.push(gap(READINESS.METHOD_NOTE_MISSING, "RECORD_METHOD", "Describe the method that was observed."));

  const included = (doc.observations || []).filter((o) => o.included !== false);
  if (!included.length) {
    gaps.push(gap(READINESS.NO_INCLUDED_OBSERVATION, "TIME_A_CYCLE", "Time at least one cycle that counts."));
  }
  if (doc.ratingPercent === null || doc.ratingPercent === undefined) {
    gaps.push(gap(READINESS.RATING_MISSING, "RATE_PERFORMANCE", "Judge the operator's pace as a performance rating."));
  }
  if (!doc.result?.calculationComplete) {
    gaps.push(gap(READINESS.CALCULATION_INCOMPLETE, "COMPLETE_CALCULATION_INPUTS",
      "The normal time cannot be calculated yet."));
  }
  if ((doc.submissions || []).some((sub) => sub.status === SUBMISSION_STATUS.IN_REVIEW)) {
    gaps.push(gap(READINESS.ALREADY_IN_REVIEW, "AWAIT_REVIEW", "A submission of this study is already in review."));
  }
  if ((doc.submissions || []).length >= LIMITS.SUBMISSIONS) {
    /* Refused rather than dropping the oldest: no returned submission is ever
       deleted, so the cap has to stop the next attempt instead. */
    gaps.push(gap(READINESS.SUBMISSION_LIMIT, "OPEN_NEW_STUDY",
      `This study has been submitted ${LIMITS.SUBMISSIONS} times. Open a new study rather than a further attempt.`));
  }

  /* The allowance policy for the DAY IT WAS STUDIED — checked last, because it
     is the only requirement that is not about the study itself. */
  if (doc.studiedAt) {
    const policy = await policyFor(doc.studiedAt);
    if (!policy) {
      gaps.push(gap(READINESS.NO_EFFECTIVE_POLICY, "PUBLISH_ALLOWANCE_POLICY",
        `No allowance policy is published as effective on ${ieAllowancePolicy.asDay(doc.studiedAt)}.`,
        { requestedDate: ieAllowancePolicy.asDay(doc.studiedAt) }));
    }
  }

  return { ready: gaps.length === 0, gaps };
}

/**
 * A per-request resolver for "which policy applied on this day", memoised.
 *
 * Returns null rather than throwing where there is none: readiness reports it
 * as a gap, and only the submit path turns it into a refusal.
 */
function policyResolver(ctx) {
  const cache = new Map();
  return async (when) => {
    const day = ieAllowancePolicy.asDay(when);
    if (!day) return null;
    if (cache.has(day)) return cache.get(day);
    let found = null;
    try {
      const { doc } = await ieAllowancePolicy.effectivePolicyDoc(ctx, day);
      found = doc;
    } catch (err) {
      if (err?.code !== "IE_ALLOWANCE_POLICY_NOT_EFFECTIVE") throw err;
      found = null;
    }
    cache.set(day, found);
    return found;
  };
}

/** What this RECORD permits next. State only — never who is asking. */
function availableActionsFor(doc, { applicability, ready }) {
  if (doc.status === STUDY_STATUS.DRAFT) {
    const actions = applicability === APPLICABILITY.CURRENT ? ["EDIT"] : [];
    if (ready) actions.push("SUBMIT");
    return actions;
  }
  if (doc.status === STUDY_STATUS.IN_REVIEW) return ["RETURN", "APPROVE"];
  return [];
}

/**
 * @param {string} applicability  derived against the file, never stored.
 * @param {boolean} withHistory   detail reads carry it; a list does not.
 * @param {object}  readiness     submission readiness, computed by the caller.
 */
function publishStudy(doc, { applicability, withHistory = false, readiness = null } = {}) {
  const observations = (doc.observations || []).map(publishObservation);
  return {
    studyId: String(doc._id),
    companyId: String(doc.companyId),
    ieStyleFileId: String(doc.ieStyleFileId),
    sampleStyleId: String(doc.sampleStyleId),
    bulletinRowId: doc.bulletinRowId,
    /* The row's operation as it was when this study opened. */
    operation: {
      ieOperationId: String(doc.ieOperationId),
      ieOperationRevision: doc.ieOperationRevision,
      operationCode: doc.operationCode || "",
      operationName: doc.operationName || "",
      machineType: doc.machineType || "",
    },
    status: doc.status,
    revision: doc.revision,
    studiedAt: doc.studiedAt ? new Date(doc.studiedAt).toISOString() : null,
    location: doc.location || "",
    methodNote: doc.methodNote || "",
    evidenceNote: doc.evidenceNote || "",
    ratingPercent: doc.ratingPercent ?? null,
    observations,
    observationCount: observations.length,
    result: {
      includedCycleCount: doc.result?.includedCycleCount ?? 0,
      excludedCycleCount: doc.result?.excludedCycleCount ?? 0,
      averageObservedSeconds: doc.result?.averageObservedSeconds ?? null,
      ratingPercent: doc.result?.ratingPercent ?? null,
      normalTimeSeconds: doc.result?.normalTimeSeconds ?? null,
      normalTimeMinutes: doc.result?.normalTimeMinutes ?? null,
      calculationComplete: Boolean(doc.result?.calculationComplete),
    },
    applicability,
    /* Said rather than left to be inferred: only a CURRENT DRAFT accepts an
       edit. IN_REVIEW is frozen while somebody decides, and APPROVED is
       permanent. */
    editable: applicability === APPLICABILITY.CURRENT && doc.status === STUDY_STATUS.DRAFT,

    /* ── THE LIFECYCLE, CHUNK 4B ────────────────────────────────────────── */
    currentSubmission: summariseSubmission(openSubmissionOf(doc)),
    approvedSubmission: summariseSubmission(submissionById(doc, doc.approvedSubmissionId)),
    submissionCount: (doc.submissions || []).length,
    /* The conclusion, frozen at approval. Null on everything else — never a
       zero, which would read as "no time needed". */
    approvedStandardTime: doc.approved?.submissionId ? {
      submissionId: doc.approved.submissionId,
      standardTimeSeconds: doc.approved.standardTimeSeconds ?? null,
      standardTimeMinutes: doc.approved.standardTimeMinutes ?? null,
      standardTimeSource: doc.approved.standardTimeSource || null,
      normalTimeSeconds: doc.approved.normalTimeSeconds ?? null,
      totalAllowancePercent: doc.approved.totalAllowancePercent ?? null,
      allowancePolicyId: doc.approved.allowancePolicyId ? String(doc.approved.allowancePolicyId) : null,
      approvedAt: doc.approved.at ? new Date(doc.approved.at).toISOString() : null,
      approvedByName: doc.approved.byName || "",
    } : null,
    /* Everything standing between this study and a submission. */
    submissionReadiness: readiness || null,
    /* What the RECORD permits next — state, never the actor's identity. The
       route still enforces the role and maker-checker on the action itself. */
    availableActions: availableActionsFor(doc, { applicability, ready: Boolean(readiness?.ready) }),
    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    /* Truthful now that submission exists: it is whether this RECORD could be
       submitted, not whether the caller may do it. `approvalChunk` keeps its
       Chunk 4A key and meaning — which chunk owns approval — and that is this
       one, now implemented. */
    canSubmit: Boolean(readiness?.ready),
    approvalChunk: "CHUNK_4B",
  };
}

/* ═══ VALIDATION ═══════════════════════════════════════════════════════════
 *
 * Field errors use the shared shape every IE refusal already carries:
 *   details.fieldErrors = [{ field, code, message }] and details.field.
 * An observation names itself twice over — by index for the form
 * (`observations.2.durationSeconds`) and by `observationId` where it has one,
 * because a list that has been reordered on screen is not addressable by index
 * alone.
 */
class FieldErrors {
  constructor() { this.list = []; }
  add(field, code, message, extra = {}) { this.list.push({ field, code, message, ...extra }); return this; }
  get any() { return this.list.length > 0; }
  throwIfAny(codeKey, message) {
    if (!this.any) return;
    throw fail(codeKey, message, { fieldErrors: this.list, field: this.list[0].field });
  }
}

function assertShape(body, allowed, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `That is not ${label}.`);
  }
  for (const key of Object.keys(body)) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A method study cannot carry ${refused}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `This record does not accept "${key}".` }] });
    }
    if (!allowed.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${label}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of ${label}.` }] });
    }
  }
}

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this study you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this study you read." }],
    });
  }
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "A revision is a whole number.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "NOT_AN_INTEGER", message: "A revision is a whole number." }],
    });
  }
  return expected;
}

/**
 * The performance rating.
 *
 * Strictly above zero: a rating of zero says the operator was not working,
 * which would make every normal time zero — a number a costing would happily
 * consume. Capped at 500 because a rating five times normal pace is a typo, not
 * an observation.
 */
function readRating(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!isFiniteNumber(value)) {
    throw fail("IE_METHOD_STUDY_RATING_INVALID", "A performance rating is a percentage, as a number.", {
      field: "ratingPercent",
      fieldErrors: [{ field: "ratingPercent", code: "INVALID", message: "A performance rating is a percentage, as a number." }],
    });
  }
  if (value <= 0 || value > LIMITS.RATING_PERCENT) {
    throw fail("IE_METHOD_STUDY_RATING_INVALID",
      `A performance rating is above 0 and at most ${LIMITS.RATING_PERCENT}. 100 means the observed pace was normal pace.`,
      {
        field: "ratingPercent",
        fieldErrors: [{ field: "ratingPercent", code: "OUT_OF_RANGE", message: `A rating is above 0 and at most ${LIMITS.RATING_PERCENT}.` }],
      });
  }
  return round4(value);
}

function readStudiedAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) {
    throw fail("VALIDATION", "That study date is not a date.", {
      field: "studiedAt",
      fieldErrors: [{ field: "studiedAt", code: "INVALID", message: "That study date is not a date." }],
    });
  }
  return when;
}

function readText(value, field, max, errs) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    errs.add(field, "INVALID", "That is text.");
    return "";
  }
  const text = value.trim();
  if (text.length > max) {
    errs.add(field, "TOO_LONG", `This is at most ${max} characters.`);
    return "";
  }
  return text;
}

/**
 * Shape the cycles a caller sent into cycles this study may store.
 *
 * EVERYTHING is validated before anything is written: one bad cycle in a sheet
 * of twenty refuses the whole save, because a half-recorded study is evidence
 * of nothing.
 *
 * An `observationId` the study already holds keeps that cycle's identity; one
 * it does not hold is refused rather than quietly minted, because a client
 * sending an unknown id is out of step with the record and inventing the cycle
 * would hide that. Genuinely new cycles arrive without an id and get one.
 */
function shapeObservations(list, existingById) {
  if (!Array.isArray(list)) {
    throw fail("IE_METHOD_STUDY_OBSERVATION_INVALID", "Observations are a list of timed cycles.", {
      field: "observations",
      fieldErrors: [{ field: "observations", code: "NOT_A_LIST", message: "Observations are a list of timed cycles." }],
    });
  }
  if (list.length > LIMITS.OBSERVATIONS) {
    throw fail("IE_METHOD_STUDY_OBSERVATION_INVALID", `A study holds at most ${LIMITS.OBSERVATIONS} cycles.`, {
      field: "observations",
      fieldErrors: [{ field: "observations", code: "TOO_MANY", message: `A study holds at most ${LIMITS.OBSERVATIONS} cycles.` }],
    });
  }

  const errs = new FieldErrors();
  const missingReason = new FieldErrors();
  const seen = new Set();
  const shaped = [];

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    const at = (f) => `observations.${i}.${f}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.add(`observations.${i}`, "INVALID", "Every observation is an object.");
      continue;
    }
    for (const key of Object.keys(raw)) {
      const refused = OBSERVATION_REFUSED[key];
      if (refused) {
        throw fail("FIELD_NOT_ACCEPTED", `An observation cannot carry ${refused}.`,
          { field: at(key), fieldErrors: [{ field: at(key), code: "NOT_ACCEPTED", message: `An observation cannot carry "${key}".` }] });
      }
      if (!OBSERVATION_FIELDS.includes(key)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of an observation.`,
          { field: at(key), fieldErrors: [{ field: at(key), code: "NOT_ACCEPTED", message: `"${key}" is not part of an observation.` }] });
      }
    }

    let observationId = str(raw.observationId);
    if (observationId) {
      if (!existingById.has(observationId)) {
        errs.add(at("observationId"), "INVALID", "That cycle is not part of this study.", { observationId });
      } else if (seen.has(observationId)) {
        errs.add(at("observationId"), "DUPLICATE", "The same cycle appears twice.", { observationId });
      }
      seen.add(observationId);
    } else {
      observationId = mintObservationId();
    }

    /* Strictly greater than zero: an operation that took no time was not
       observed, and a zero would silently drag every average down. */
    const duration = raw.durationSeconds;
    let durationSeconds = null;
    if (!isFiniteNumber(duration)) {
      errs.add(at("durationSeconds"), "REQUIRED", "Record how many seconds this cycle took.", { observationId });
    } else if (duration <= 0) {
      errs.add(at("durationSeconds"), "OUT_OF_RANGE", "A timed cycle is longer than zero seconds.", { observationId });
    } else if (duration > LIMITS.DURATION_SECONDS) {
      errs.add(at("durationSeconds"), "OUT_OF_RANGE", `A cycle is at most ${LIMITS.DURATION_SECONDS} seconds.`, { observationId });
    } else {
      durationSeconds = round4(duration);
    }

    if (raw.included !== undefined && typeof raw.included !== "boolean") {
      errs.add(at("included"), "INVALID", "Included is true or false.", { observationId });
    }
    const included = raw.included === undefined ? true : raw.included === true;

    const note = readText(raw.note, at("note"), LIMITS.NOTE, errs);
    const reason = readText(raw.exclusionReason, at("exclusionReason"), LIMITS.EXCLUSION_REASON, errs);

    if (!included && !reason) {
      /* Its own typed refusal, not a generic validation error: "you excluded a
         cycle and did not say why" is the one mistake that quietly destroys a
         study's credibility months later, when nobody can remember. */
      missingReason.add(at("exclusionReason"), "REQUIRED",
        "Say why this cycle does not count.", { observationId });
    }

    shaped.push({
      observationId,
      sequence: shaped.length + 1,
      durationSeconds,
      included,
      /* An included cycle carries no exclusion reason. Cleared rather than
         refused: a screen that re-includes a cycle sends the reason it had a
         moment ago, and the stored record is what must not keep it. The
         response echoes exactly what was stored, so nothing is hidden. */
      exclusionReason: included ? "" : reason,
      note,
    });
  }

  errs.throwIfAny("IE_METHOD_STUDY_OBSERVATION_INVALID", "Some of these cycles need fixing.");
  missingReason.throwIfAny("IE_METHOD_STUDY_EXCLUSION_REASON_REQUIRED",
    "An excluded cycle has to say why it does not count.");
  return shaped;
}

/** Recompute the stored calculation from what the record will hold. */
const resultFor = (observations, ratingPercent) =>
  calculateMethodStudy({ observations, ratingPercent });

/* ═══ CREATE ═══════════════════════════════════════════════════════════════ */

/**
 * Open — or resume — the draft study for a bulletin row.
 *
 * ── WHY THE IDEMPOTENCE IS THE INDEX ────────────────────────────────────────
 * "Find one, create it if absent" is two operations, and two simultaneous
 * requests both find nothing. The unique partial index on
 * (company, file, row, operation, operation revision) is what decides; the
 * loser reads the winner's draft and returns it. Which is what a double-clicked
 * "Start method study" button actually sends.
 */
async function createStudy(ctx, { fileId, rowId, body = {}, actor = null } = {}) {
  assertContext(ctx);
  /* Creation takes no body: everything about a new study is derived from the
     owned file and its current row. */
  for (const key of Object.keys(body || {})) {
    throw fail("FIELD_NOT_ACCEPTED",
      `A method study is opened from a bulletin row. It cannot carry "${key}".`,
      { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of opening a method study.` }] });
  }

  const file = await loadOwnedFile(ctx, fileId);
  const row = rowOf(file, rowId);
  if (!row) throw rowNotFound();

  /* ── THE SLOT THIS STUDY WOULD OCCUPY ──────────────────────────────────
     One ACTIVE study per row-operation, where active means DRAFT or IN_REVIEW.
     Resuming therefore looks for either: a study that has been submitted is
     still this operation's study, and starting a second one beside it would
     leave the reviewer's decision landing on a record nobody is editing — and
     would collide with the second draft the moment the first was returned. */
  const identity = {
    companyId: ctx.companyId,
    ieStyleFileId: file._id,
    bulletinRowId: row.rowId,
    ieOperationId: row.ieOperationId,
    ieOperationRevision: row.ieOperationRevision,
  };
  const activeQuery = { ...identity, status: { $in: [STUDY_STATUS.DRAFT, STUDY_STATUS.IN_REVIEW] } };

  const existing = await IeMethodStudy.findOne(activeQuery).lean();
  if (existing) {
    /* Resumed, whichever active state it is in — the caller gets the real
       record and its `availableActions` say what may happen to it next. */
    return { study: await publishWithReadiness(ctx, existing, file), created: false };
  }

  const doc = {
    ...identity,
    status: STUDY_STATUS.DRAFT,
    sampleStyleId: file.sampleStyleId,
    /* Captured from the ROW — see the header. */
    operationCode: row.operationCode || "",
    operationName: row.operationName || "",
    machineType: row.machineType || "",
    revision: 1,
    studiedAt: null,
    location: "",
    methodNote: "",
    evidenceNote: "",
    ratingPercent: null,
    observations: [],
    result: resultFor([], null),
    history: [event("METHOD_STUDY_CREATED", {
      actor,
      studyRevision: 1,
      changed: [],
      summary: `Opened for ${row.operationCode || row.operationName || "this operation"}`
        + ` at revision ${row.ieOperationRevision}`,
    })],
    createdBy: actorId(actor),
    createdByName: actorName(actor),
    updatedBy: actorId(actor),
    updatedByName: actorName(actor),
  };

  try {
    const created = await IeMethodStudy.create(doc);
    return { study: await publishWithReadiness(ctx, created.toObject(), file), created: true };
  } catch (err) {
    if (!isDuplicateActiveStudy(err)) throw err;
    /* Somebody else opened it first — the same answer as asking twice. */
    const winner = await IeMethodStudy.findOne(activeQuery).lean();
    if (winner) return { study: await publishWithReadiness(ctx, winner, file), created: false };
    /* Lost the race to an open AND had that study approved before this read: the
       slot is free again but this request's insert is already spent. A typed
       conflict, never the raw duplicate key — read the row's studies and decide. */
    throw fail("IE_METHOD_STUDY_TRANSITION_INVALID",
      "Another study for this operation was opened and decided while this request was in flight. Read the row's studies again.",
      { bulletinRowId: row.rowId, reason: "ACTIVE_STUDY_RACE" });
  }
}

/* ═══ READ ═════════════════════════════════════════════════════════════════ */

/**
 * Every study for one row of one owned file, newest first.
 *
 * Includes the stale ones. That is the point of the endpoint: when a row's
 * operation is replaced, the reason the old time was what it was lives in the
 * study that no longer applies, and a list that hid it would leave a reviewer
 * asking where the evidence went.
 */
async function listStudies(ctx, { fileId, rowId, limit, cursor } = {}) {
  const file = await loadOwnedFile(ctx, fileId);
  const wantedRow = str(rowId);
  if (!wantedRow) throw rowNotFound();
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");
  /* One policy lookup per distinct study date for the whole page. */
  const policyFor = policyResolver(ctx);

  const and = [{ companyId: ctx.companyId, ieStyleFileId: file._id, bulletinRowId: wantedRow }];
  if (after) {
    /* Newest first, so the page continues at records OLDER than the marker.
       `_id` breaks ties, so two studies created in the same millisecond cannot
       hide each other. */
    and.push({
      $or: [
        { createdAt: { $lt: new Date(after.t) } },
        { createdAt: new Date(after.t), _id: { $lt: oid(after.i) } },
      ],
    });
  }

  const found = await IeMethodStudy.find({ $and: and })
    .sort({ createdAt: -1, _id: -1 })
    .limit(size + 1)
    .lean();

  const page = found.slice(0, size);
  const last = page[page.length - 1];
  return {
    bulletinRowId: wantedRow,
    /* Absent when the row itself is gone — the studies are still listed, and
       the row's absence is what their applicability then says. */
    rowPresent: Boolean(rowOf(file, wantedRow)),
    studies: await Promise.all(page.map(async (row) => {
      const applicability = applicabilityOf(row, file);
      return publishStudy(row, {
        applicability,
        readiness: await submissionReadiness(row, { applicability, policyFor }),
      });
    })),
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: String(last._id) })
      : null,
    sort: "createdAt:desc,_id:desc",
  };
}

/** One study of THIS company, with its calculations, history and applicability. */
async function loadOwnedStudy(ctx, studyId) {
  assertContext(ctx);
  if (!isId(studyId)) throw studyNotFound();
  const doc = await IeMethodStudy.findOne({ _id: oid(studyId), companyId: ctx.companyId }).lean();
  if (!doc) throw studyNotFound();
  return doc;
}

async function readStudy(ctx, { studyId } = {}) {
  const doc = await loadOwnedStudy(ctx, studyId);
  /* The file is loaded under the SAME company bound, so a study whose file
     somehow left this company reads as not found rather than as applicable. */
  const file = await IeStyleFile.findOne({ _id: doc.ieStyleFileId, companyId: ctx.companyId })
    .select("_id bulletin.rows").lean();
  if (!file) throw studyNotFound();
  return { study: await publishWithReadiness(ctx, doc, file) };
}

/** One study, published with its readiness resolved — the detail shape. */
async function publishWithReadiness(ctx, doc, file, { withHistory = true } = {}) {
  const applicability = applicabilityOf(doc, file);
  const readiness = await submissionReadiness(doc, { applicability, policyFor: policyResolver(ctx) });
  return publishStudy(doc, { applicability, withHistory, readiness });
}

/** The file this study belongs to, under the same company bound. */
async function loadStudyFile(ctx, study) {
  const file = await IeStyleFile.findOne({ _id: study.ieStyleFileId, companyId: ctx.companyId })
    .select("_id bulletin.rows").lean();
  if (!file) throw studyNotFound();
  return file;
}

/* ═══ EDIT ═════════════════════════════════════════════════════════════════ */

/** The cycles, compared as they are persisted. */
function sameObservations(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].observationId !== b[i].observationId) return false;
    if (a[i].sequence !== b[i].sequence) return false;
    if ((a[i].durationSeconds ?? null) !== (b[i].durationSeconds ?? null)) return false;
    if ((a[i].included !== false) !== (b[i].included !== false)) return false;
    if ((a[i].exclusionReason || "") !== (b[i].exclusionReason || "")) return false;
    if ((a[i].note || "") !== (b[i].note || "")) return false;
  }
  return true;
}

/** Did the study's own recorded facts move? */
function sameMetadata(a, b) {
  const at = (s) => (s.studiedAt ? new Date(s.studiedAt).getTime() : null);
  if (at(a) !== at(b)) return false;
  for (const f of ["location", "methodNote", "evidenceNote"]) {
    if ((a[f] || "") !== (b[f] || "")) return false;
  }
  return true;
}

/** Is what the caller composed already what is stored? */
function sameStudy(before, after) {
  return sameMetadata(before, after)
    && (before.ratingPercent ?? null) === (after.ratingPercent ?? null)
    && sameObservations(before.observations || [], after.observations || []);
}

/**
 * WHICH KINDS of thing changed — for the history, which stores no values.
 *
 * Categories rather than a diff on purpose: an audit line that carried every
 * cycle would put the whole study in the record again on every save, and the
 * values are already ON the study. What a reviewer needs from the history is
 * who touched what kind of thing, and when.
 */
function changedCategories(before, after) {
  const changed = [];
  if (!sameMetadata(before, after)) changed.push("metadata");
  if ((before.ratingPercent ?? null) !== (after.ratingPercent ?? null)) changed.push("rating");
  if (!sameObservations(before.observations || [], after.observations || [])) changed.push("observations");
  return changed;
}

/**
 * Edit the draft.
 *
 * The preconditions are checked in the order a person needs to hear them:
 *
 *   1. is this study yours (and does it exist) — one non-disclosing answer;
 *   2. is the body shaped like a study at all;
 *   3. does it STILL apply to the bulletin — a study whose row was removed or
 *      re-operationed cannot be edited at all, so saying "your revision is
 *      stale" would send somebody to re-read and try again for ever;
 *   4. is the revision the one they read — enforced here so a stale request is
 *      refused even when its values happen to match what is stored, because
 *      the caller is deciding from a state that no longer exists;
 *   5. and only then, does it actually change anything.
 *
 * The write itself is ONE conditional update carrying the revision and the
 * status, so two simultaneous edits cannot both land.
 */
async function updateStudy(ctx, { studyId, body = {}, actor = null } = {}) {
  const current = await loadOwnedStudy(ctx, studyId);
  assertShape(body, PATCH_FIELDS, "a method study");
  const expected = readExpectedRevision(body.expectedRevision);

  const file = await loadStudyFile(ctx, current);

  /* ── ONLY A DRAFT IS EDITABLE ───────────────────────────────────────────
     Checked before the revision, because "your revision is stale" is unfixable
     advice for a study that is frozen whatever revision you quote. IN_REVIEW is
     awaiting somebody's decision; APPROVED is permanent evidence. */
  if (current.status !== STUDY_STATUS.DRAFT) {
    throw fail("IE_METHOD_STUDY_TRANSITION_INVALID",
      current.status === STUDY_STATUS.IN_REVIEW
        ? "This study is with a reviewer and cannot be changed. It has to be returned first."
        : "This study is approved. Its evidence is permanent — open a new study to re-time the operation.",
      { studyId: String(current._id), status: current.status, allowedActions: availableActionsFor(current, { applicability: APPLICABILITY.CURRENT, ready: false }) });
  }

  const applicability = applicabilityOf(current, file);
  if (applicability !== APPLICABILITY.CURRENT) {
    throw fail("IE_METHOD_STUDY_SOURCE_CHANGED",
      applicability === APPLICABILITY.ROW_REMOVED
        ? "The bulletin row this study was timed against has been removed. The study stays as evidence and cannot be changed."
        : "The bulletin row now names a different operation. This study stays as the evidence for what it timed — open a new study for the new operation.",
      { studyId: String(current._id), applicability, bulletinRowId: current.bulletinRowId });
  }

  if (current.revision !== expected) {
    throw fail("IE_METHOD_STUDY_REVISION_CONFLICT",
      "Somebody changed this method study while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, studyId: String(current._id) });
  }

  const errs = new FieldErrors();
  const next = {
    studiedAt: "studiedAt" in body ? readStudiedAt(body.studiedAt) : (current.studiedAt || null),
    location: "location" in body ? readText(body.location, "location", LIMITS.LOCATION, errs) : (current.location || ""),
    methodNote: "methodNote" in body ? readText(body.methodNote, "methodNote", LIMITS.NOTE, errs) : (current.methodNote || ""),
    evidenceNote: "evidenceNote" in body ? readText(body.evidenceNote, "evidenceNote", LIMITS.NOTE, errs) : (current.evidenceNote || ""),
    ratingPercent: "ratingPercent" in body ? readRating(body.ratingPercent) : (current.ratingPercent ?? null),
  };
  errs.throwIfAny("VALIDATION", "This study cannot be saved yet.");

  const existingById = new Map((current.observations || []).map((o) => [o.observationId, o]));
  next.observations = "observations" in body
    ? shapeObservations(body.observations, existingById)
    : (current.observations || []).map((o) => ({ ...o }));

  if (sameStudy(current, next)) {
    /* Nothing to write. A form that re-sends on blur would otherwise walk the
       revision up and refuse a second engineer's real edit, and fill the audit
       trail with entries nobody can act on. */
    return {
      study: await publishWithReadiness(ctx, current, file),
      updated: false,
      events: [],
    };
  }

  const changed = changedCategories(current, next);
  const result = resultFor(next.observations, next.ratingPercent);
  const nextRevision = expected + 1;
  const audit = event("METHOD_STUDY_EDITED", {
    actor,
    studyRevision: nextRevision,
    changed,
    summary: `Changed ${changed.join(", ") || "the study"}`
      + ` — ${result.includedCycleCount} of ${next.observations.length} cycles included`,
  });

  const updated = await IeMethodStudy.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: {
        studiedAt: next.studiedAt,
        location: next.location,
        methodNote: next.methodNote,
        evidenceNote: next.evidenceNote,
        ratingPercent: next.ratingPercent,
        observations: next.observations,
        result,
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      /* Same write, so there is no window in which the study moved and its
         history did not. `$slice` keeps the array bounded in the same breath. */
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    /* Lost a race between the read above and this write. One company-scoped
       re-read to say so, and nothing about anybody else's record. */
    const now = await IeMethodStudy.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision").lean();
    if (!now) throw studyNotFound();
    throw fail("IE_METHOD_STUDY_REVISION_CONFLICT",
      "Somebody changed this method study while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, studyId: String(now._id) });
  }

  return {
    study: await publishWithReadiness(ctx, updated, file),
    updated: true,
    events: [publishEvent(audit)],
  };
}

/* ═══ THE LIFECYCLE ════════════════════════════════════════════════════════
 *
 * DRAFT ──submit──▶ IN_REVIEW ──approve──▶ APPROVED
 *   ▲                   │
 *   └───────return──────┘
 *
 * No other transition exists. Each action is ONE conditional update whose filter
 * carries the study's id, its company, the expected revision AND the status it
 * must currently be in — so a stale request is refused even when the outcome it
 * asks for already looks true, and two simultaneous decisions cannot both land.
 * The submission's own state moves in the same write, through `arrayFilters`,
 * which is what makes "approved study, unapproved submission" unreachable.
 */

const mintSubmissionId = () => `sub_${crypto.randomBytes(9).toString("hex")}`;

/** The person acting, as an identity. Maker-checker needs one. */
function requireActorIdentity(actor, what) {
  const id = actorId(actor);
  if (!id) {
    throw fail("IE_METHOD_STUDY_MAKER_CHECKER", `${what} has to be attributable to a person.`);
  }
  return id;
}

/**
 * The manual standard-time override, if one was asked for.
 *
 * Optional, positive, finite, and never without a reason: an override replaces
 * a measured figure with a judgement, and a judgement nobody wrote down is
 * indistinguishable from a typo six months later.
 */
function readOverride(body) {
  const asked = body.manualStandardTimeMinutes;
  const reason = str(body.overrideReason);

  if (asked === undefined || asked === null || asked === "") {
    /* A reason with no override is a body that lost its number — refused
       rather than silently ignored. */
    if (reason) {
      throw fail("IE_METHOD_STUDY_OVERRIDE_INVALID",
        "There is an override reason but no override time.",
        {
          field: "manualStandardTimeMinutes",
          fieldErrors: [{ field: "manualStandardTimeMinutes", code: "REQUIRED", message: "Give the standard time you are asking for, or remove the reason." }],
        });
    }
    return null;
  }

  if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) {
    throw fail("IE_METHOD_STUDY_OVERRIDE_INVALID",
      "An override standard time is a number of minutes above zero.",
      {
        field: "manualStandardTimeMinutes",
        fieldErrors: [{ field: "manualStandardTimeMinutes", code: "INVALID", message: "An override standard time is a number of minutes above zero." }],
      });
  }
  if (!reason) {
    throw fail("IE_METHOD_STUDY_OVERRIDE_REASON_REQUIRED",
      "Say why the calculated standard time is being overridden.",
      {
        field: "overrideReason",
        fieldErrors: [{ field: "overrideReason", code: "REQUIRED", message: "Say why the calculated standard time is being overridden." }],
      });
  }
  if (reason.length > LIMITS.OVERRIDE_REASON) {
    throw fail("IE_METHOD_STUDY_OVERRIDE_INVALID", `A reason is at most ${LIMITS.OVERRIDE_REASON} characters.`,
      { field: "overrideReason", fieldErrors: [{ field: "overrideReason", code: "TOO_LONG", message: `A reason is at most ${LIMITS.OVERRIDE_REASON} characters.` }] });
  }

  /* ── IT HAS TO SURVIVE ITS OWN ARITHMETIC ───────────────────────────────
     `Number.isFinite(asked)` above is not enough. Rounding multiplies by
     10,000 and the seconds multiply by 60 again, so a number that is finite in
     JSON — 1e308 is — becomes Infinity on the way to being stored. Mongo would
     keep that Infinity and `JSON.stringify` would publish it as `null`: a
     submission carrying MANUAL_OVERRIDE with no time in it, waiting for
     somebody to approve nothing.

     So both derived values are proved finite and positive before the override
     is accepted. There is no arbitrary business maximum here — no product rule
     states one — only the requirement that the number can actually be stored
     and read back. */
  const minutes = round4(asked);
  const seconds = round4(minutes * 60);
  const usable = [minutes, seconds].every((v) => Number.isFinite(v) && v > 0)
    /* And that it round-trips as JSON, which is how it reaches every reader. */
    && Number.isFinite(JSON.parse(JSON.stringify({ minutes, seconds })).minutes);
  if (!usable) {
    throw fail("IE_METHOD_STUDY_OVERRIDE_INVALID",
      "That override standard time is too large to record.",
      {
        field: "manualStandardTimeMinutes",
        fieldErrors: [{ field: "manualStandardTimeMinutes", code: "OUT_OF_RANGE", message: "That override standard time is too large to record." }],
      });
  }
  return { minutes, seconds, reason };
}

/** The study must be in this state, or say what state it is in. */
function assertStatus(doc, wanted, message) {
  if (doc.status === wanted) return;
  throw fail("IE_METHOD_STUDY_TRANSITION_INVALID", message, {
    studyId: String(doc._id),
    status: doc.status,
    requiredStatus: wanted,
  });
}

function assertRevision(doc, expected) {
  if (doc.revision === expected) return;
  /* Refused even when the outcome asked for already looks true: the caller is
     deciding from a state that no longer exists. */
  throw fail("IE_METHOD_STUDY_REVISION_CONFLICT",
    "Somebody changed this method study while you were working on it. Re-read it and decide again.",
    { expected, actual: doc.revision, studyId: String(doc._id) });
}

/** A miss on a lifecycle update: say which precondition failed, and nothing else. */
async function explainLifecycleMiss(ctx, studyId, { expected, requiredStatus }) {
  const now = await IeMethodStudy.findOne({ _id: studyId, companyId: ctx.companyId })
    .select("_id revision status currentSubmissionId").lean();
  if (!now) throw studyNotFound();
  if (requiredStatus && now.status !== requiredStatus) {
    throw fail("IE_METHOD_STUDY_TRANSITION_INVALID",
      `This study is ${now.status} and that action needs it to be ${requiredStatus}.`,
      { studyId: String(now._id), status: now.status, requiredStatus });
  }
  throw fail("IE_METHOD_STUDY_REVISION_CONFLICT",
    "Somebody changed this method study while you were working on it. Re-read it and decide again.",
    { expected, actual: now.revision, studyId: String(now._id) });
}

/**
 * SUBMIT — freeze everything and hand it to a reviewer.
 *
 * The normal time is RECALCULATED here from the stored cycles rather than taken
 * from the stored result: the figure that gets frozen has to be one this server
 * derived at this moment, not one a previous write left behind.
 */
async function submitStudy(ctx, { studyId, body = {}, actor = null } = {}) {
  const current = await loadOwnedStudy(ctx, studyId);
  assertShape(body, SUBMIT_FIELDS, "a submission");
  const expected = readExpectedRevision(body.expectedRevision);
  const file = await loadStudyFile(ctx, current);
  const applicability = applicabilityOf(current, file);

  assertStatus(current, STUDY_STATUS.DRAFT,
    current.status === STUDY_STATUS.IN_REVIEW
      ? "This study is already with a reviewer."
      : "This study is approved. Open a new study to re-time the operation.");
  assertRevision(current, expected);

  const submitter = requireActorIdentity(actor, "Submitting a method study");
  const override = readOverride(body);

  const policyFor = policyResolver(ctx);
  const readiness = await submissionReadiness(current, { applicability, policyFor });
  if (!readiness.ready) {
    /* Every missing requirement, at once, each with its own code. */
    throw fail("IE_METHOD_STUDY_NOT_READY",
      "This method study is not ready to submit yet.",
      { studyId: String(current._id), gaps: readiness.gaps });
  }

  /* The published policy effective on the day it was STUDIED. Readiness already
     proved one exists; this resolves it for the frozen snapshot. */
  const { doc: policy } = await ieAllowancePolicy.effectivePolicyDoc(ctx, current.studiedAt);
  const snapshot = ieAllowancePolicy.snapshotOf(policy);

  /* Recomputed, not trusted. */
  const result = calculateMethodStudy({
    observations: current.observations || [],
    ratingPercent: current.ratingPercent ?? null,
  });
  if (!result.calculationComplete) {
    throw fail("IE_METHOD_STUDY_NOT_READY", "This method study is not ready to submit yet.", {
      studyId: String(current._id),
      gaps: [gap(READINESS.CALCULATION_INCOMPLETE, "COMPLETE_CALCULATION_INPUTS", "The normal time cannot be calculated yet.")],
    });
  }

  const calculated = calculateStandardTime({
    normalTimeSeconds: result.normalTimeSeconds,
    totalAllowancePercent: snapshot.totalAllowancePercent,
  });

  const submissionId = mintSubmissionId();
  const now = new Date();
  const submission = {
    submissionId,
    sourceStudyRevision: current.revision,
    studiedAt: current.studiedAt,
    location: current.location || "",
    methodNote: current.methodNote || "",
    evidenceNote: current.evidenceNote || "",
    ratingPercent: current.ratingPercent ?? null,
    observations: (current.observations || []).map((o) => ({
      observationId: o.observationId, sequence: o.sequence, durationSeconds: o.durationSeconds,
      included: o.included !== false, exclusionReason: o.exclusionReason || "", note: o.note || "",
    })),
    result,
    allowancePolicy: snapshot,
    /* BOTH figures are kept whatever happens next. */
    calculatedStandardTimeSeconds: calculated.standardTimeSeconds,
    calculatedStandardTimeMinutes: calculated.standardTimeMinutes,
    manualStandardTimeMinutes: override ? override.minutes : null,
    overrideReason: override ? override.reason : "",
    standardTimeSource: override ? SOURCE.MANUAL_OVERRIDE : SOURCE.CALCULATED,
    /* The seconds computed and proved finite alongside the minutes in
       `readOverride`, rather than multiplied again here. */
    standardTimeSeconds: override ? override.seconds : calculated.standardTimeSeconds,
    standardTimeMinutes: override ? override.minutes : calculated.standardTimeMinutes,
    submittedBy: submitter,
    submittedByName: actorName(actor),
    submittedAt: now,
    status: SUBMISSION_STATUS.IN_REVIEW,
    reviewedBy: null,
    reviewedByName: "",
    reviewedAt: null,
    reviewNote: "",
  };

  const nextRevision = expected + 1;
  const audit = event("METHOD_STUDY_SUBMITTED", {
    actor,
    studyRevision: nextRevision,
    changed: ["status", "submission"],
    summary: `Submitted for review — ${submission.standardTimeMinutes} min standard`
      + ` (${submission.standardTimeSource === SOURCE.MANUAL_OVERRIDE ? "manual override" : "calculated"},`
      + ` ${snapshot.totalAllowancePercent}% allowance)`,
  });

  const updated = await IeMethodStudy.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: STUDY_STATUS.DRAFT },
    {
      $set: { status: STUDY_STATUS.IN_REVIEW, currentSubmissionId: submissionId },
      $inc: { revision: 1 },
      /* No `$slice` on submissions: the readiness cap refuses a further attempt
         rather than discarding an older one. */
      $push: { submissions: submission, history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) await explainLifecycleMiss(ctx, current._id, { expected, requiredStatus: STUDY_STATUS.DRAFT });

  return {
    study: await publishWithReadiness(ctx, updated, file),
    submission: publishSubmission(submissionById(updated, submissionId)),
    submitted: true,
    events: [publishEvent(audit)],
  };
}

/** The open submission, and the maker-checker rule that guards deciding it. */
function currentSubmissionFor(doc, actor, action) {
  const open = submissionById(doc, doc.currentSubmissionId);
  if (!open || open.status !== SUBMISSION_STATUS.IN_REVIEW) {
    throw fail("IE_METHOD_STUDY_SUBMISSION_NOT_FOUND",
      "There is no submission of this study waiting for a decision.",
      { studyId: String(doc._id), status: doc.status });
  }
  const reviewer = requireActorIdentity(actor, `${action} a method study`);
  if (open.submittedBy && String(open.submittedBy) === String(reviewer)) {
    /* Not a missing role — the wrong PERSON. An owner and a platform
       administrator are refused on identical terms. */
    throw fail("IE_METHOD_STUDY_MAKER_CHECKER",
      `A method study has to be ${action === "Returning" ? "returned" : "approved"} by somebody other than the person who submitted it.`,
      { studyId: String(doc._id), submissionId: open.submissionId, reason: "REVIEWER_IS_SUBMITTER" });
  }
  return { open, reviewer };
}

/**
 * RETURN — send it back for correction, with a reason.
 *
 * The submission is marked RETURNED and kept for ever; only
 * `currentSubmissionId` is cleared. "What did we send back in September, and
 * why" is the question a review trail exists to answer.
 */
async function returnStudy(ctx, { studyId, body = {}, actor = null } = {}) {
  const current = await loadOwnedStudy(ctx, studyId);
  assertShape(body, RETURN_FIELDS, "a return");
  const expected = readExpectedRevision(body.expectedRevision);
  const file = await loadStudyFile(ctx, current);

  assertStatus(current, STUDY_STATUS.IN_REVIEW,
    current.status === STUDY_STATUS.DRAFT
      ? "This study is not with a reviewer, so there is nothing to return."
      : "This study is approved and cannot be returned.");
  assertRevision(current, expected);

  const reason = str(body.reason);
  if (!reason) {
    throw fail("IE_METHOD_STUDY_REVIEW_REASON_REQUIRED",
      "Say what has to be corrected before this study can be submitted again.",
      { field: "reason", fieldErrors: [{ field: "reason", code: "REQUIRED", message: "Say what has to be corrected." }] });
  }
  if (reason.length > LIMITS.REVIEW_NOTE) {
    throw fail("VALIDATION", `A reason is at most ${LIMITS.REVIEW_NOTE} characters.`,
      { field: "reason", fieldErrors: [{ field: "reason", code: "TOO_LONG", message: `A reason is at most ${LIMITS.REVIEW_NOTE} characters.` }] });
  }

  const { open, reviewer } = currentSubmissionFor(current, actor, "Returning");
  const nextRevision = expected + 1;
  const audit = event("METHOD_STUDY_RETURNED", {
    actor,
    studyRevision: nextRevision,
    changed: ["status", "submission"],
    summary: `Returned for correction — ${reason}`,
  });

  let updated;
  try {
    updated = await IeMethodStudy.findOneAndUpdate(
      {
        _id: current._id, companyId: ctx.companyId, revision: expected,
        status: STUDY_STATUS.IN_REVIEW, currentSubmissionId: open.submissionId,
      },
      {
        $set: {
          status: STUDY_STATUS.DRAFT,
          /* Cleared, so the study is editable again — the submission itself
             stays, marked RETURNED. */
          currentSubmissionId: null,
          "submissions.$[s].status": SUBMISSION_STATUS.RETURNED,
          "submissions.$[s].reviewedBy": reviewer,
          "submissions.$[s].reviewedByName": actorName(actor),
          "submissions.$[s].reviewedAt": new Date(),
          "submissions.$[s].reviewNote": reason,
        },
        $inc: { revision: 1 },
        $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
      },
      { new: true, arrayFilters: [{ "s.submissionId": open.submissionId }] },
    ).lean();
  } catch (err) {
    /* Returning moves the study back INTO the active slot. With the invariant
       in place nothing else can be holding it, so this is unreachable for data
       written under this contract — but a record from before it, or a genuine
       race, must still get a typed answer rather than a raw duplicate key. */
    if (!isDuplicateActiveStudy(err)) throw err;
    throw fail("IE_METHOD_STUDY_TRANSITION_INVALID",
      "Another study for this operation is already open, so this one cannot be returned to draft. Resolve that study first.",
      { studyId: String(current._id), bulletinRowId: current.bulletinRowId, reason: "ACTIVE_STUDY_CONFLICT" });
  }

  if (!updated) await explainLifecycleMiss(ctx, current._id, { expected, requiredStatus: STUDY_STATUS.IN_REVIEW });

  return {
    study: await publishWithReadiness(ctx, updated, file),
    submission: publishSubmission(submissionById(updated, open.submissionId)),
    returned: true,
    events: [publishEvent(audit)],
  };
}

/**
 * APPROVE — accept the submission and freeze its standard time.
 *
 * The approved figure is copied onto the study as the conclusion, and the
 * submission stays as the evidence. Nothing is written into the bulletin row and
 * nothing is released to Production, Planning or Costing: applying an approved
 * standard time is a separate decision, and this chunk deliberately has no door
 * for it.
 */
async function approveStudy(ctx, { studyId, body = {}, actor = null } = {}) {
  const current = await loadOwnedStudy(ctx, studyId);
  assertShape(body, APPROVE_FIELDS, "an approval");
  const expected = readExpectedRevision(body.expectedRevision);
  const file = await loadStudyFile(ctx, current);
  const applicability = applicabilityOf(current, file);

  assertStatus(current, STUDY_STATUS.IN_REVIEW,
    current.status === STUDY_STATUS.DRAFT
      ? "This study has not been submitted for review."
      : "This study is already approved.");
  assertRevision(current, expected);

  if (applicability !== APPLICABILITY.CURRENT) {
    /* A standard time approved against a row that has since changed operation
       or disappeared would be a standard for nothing. Return it instead. */
    throw fail("IE_METHOD_STUDY_SOURCE_CHANGED",
      applicability === APPLICABILITY.ROW_REMOVED
        ? "The bulletin row this study was timed against has been removed. It cannot be approved — return it instead."
        : "The bulletin row now names a different operation. This study cannot be approved — return it instead.",
      { studyId: String(current._id), applicability, bulletinRowId: current.bulletinRowId });
  }

  const note = str(body.note);
  if (note.length > LIMITS.REVIEW_NOTE) {
    throw fail("VALIDATION", `A note is at most ${LIMITS.REVIEW_NOTE} characters.`,
      { field: "note", fieldErrors: [{ field: "note", code: "TOO_LONG", message: `A note is at most ${LIMITS.REVIEW_NOTE} characters.` }] });
  }

  const { open, reviewer } = currentSubmissionFor(current, actor, "Approving");
  const nextRevision = expected + 1;
  const at = new Date();
  const audit = event("METHOD_STUDY_APPROVED", {
    actor,
    studyRevision: nextRevision,
    changed: ["status", "submission", "standardTime"],
    summary: `Approved — ${open.standardTimeMinutes} min standard`
      + ` (${open.standardTimeSource === SOURCE.MANUAL_OVERRIDE ? "manual override" : "calculated"})`,
  });

  const updated = await IeMethodStudy.findOneAndUpdate(
    {
      _id: current._id, companyId: ctx.companyId, revision: expected,
      status: STUDY_STATUS.IN_REVIEW, currentSubmissionId: open.submissionId,
    },
    {
      $set: {
        status: STUDY_STATUS.APPROVED,
        approvedSubmissionId: open.submissionId,
        /* The conclusion, written exactly once. */
        approved: {
          submissionId: open.submissionId,
          standardTimeSeconds: open.standardTimeSeconds ?? null,
          standardTimeMinutes: open.standardTimeMinutes ?? null,
          standardTimeSource: open.standardTimeSource || SOURCE.CALCULATED,
          normalTimeSeconds: open.result?.normalTimeSeconds ?? null,
          totalAllowancePercent: open.allowancePolicy?.totalAllowancePercent ?? null,
          allowancePolicyId: open.allowancePolicy?.policyId || null,
          at,
          byName: actorName(actor),
        },
        "submissions.$[s].status": SUBMISSION_STATUS.APPROVED,
        "submissions.$[s].reviewedBy": reviewer,
        "submissions.$[s].reviewedByName": actorName(actor),
        "submissions.$[s].reviewedAt": at,
        "submissions.$[s].reviewNote": note,
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true, arrayFilters: [{ "s.submissionId": open.submissionId }] },
  ).lean();

  if (!updated) await explainLifecycleMiss(ctx, current._id, { expected, requiredStatus: STUDY_STATUS.IN_REVIEW });

  return {
    study: await publishWithReadiness(ctx, updated, file),
    submission: publishSubmission(submissionById(updated, open.submissionId)),
    approved: true,
    events: [publishEvent(audit)],
  };
}

/**
 * Every frozen submission, newest first.
 *
 * Bounded by the same cap the record itself is bounded by, so the whole history
 * fits one response and needs no cursor; `limit` narrows it for a screen that
 * only wants the last few.
 */
async function listSubmissions(ctx, { studyId, limit } = {}) {
  const doc = await loadOwnedStudy(ctx, studyId);
  const asked = limit === undefined || limit === null || limit === "" ? LIMITS.SUBMISSIONS : Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "Ask for a whole number of submissions.", {
      field: "limit",
      fieldErrors: [{ field: "limit", code: "NOT_AN_INTEGER", message: "Ask for a whole number of submissions." }],
    });
  }
  const size = Math.min(asked, LIMITS.SUBMISSIONS);
  const all = [...(doc.submissions || [])].reverse();
  return {
    studyId: String(doc._id),
    studyRevision: doc.revision,
    status: doc.status,
    currentSubmissionId: doc.currentSubmissionId || null,
    approvedSubmissionId: doc.approvedSubmissionId || null,
    submissions: all.slice(0, size).map(publishSubmission),
    limit: size,
    total: all.length,
    retained: LIMITS.SUBMISSIONS,
    sort: "submittedAt:desc",
  };
}

module.exports = {
  APPLICABILITY, STUDY_FIELDS, PATCH_FIELDS, OBSERVATION_FIELDS, REFUSED_FIELDS,
  applicabilityOf, publishStudy, sameStudy, sameObservations, changedCategories,
  shapeObservations, readRating,
  createStudy, listStudies, readStudy, updateStudy,
  STUDY_STATUS, SUBMISSION_STATUS, SOURCE, READINESS,
  SUBMIT_FIELDS, RETURN_FIELDS, APPROVE_FIELDS,
  submissionReadiness, publishSubmission, availableActionsFor, policyResolver, openSubmissionOf,
  submitStudy, returnStudy, approveStudy, listSubmissions,
};
