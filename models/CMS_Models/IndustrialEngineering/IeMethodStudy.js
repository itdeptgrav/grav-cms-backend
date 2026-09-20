// models/CMS_Models/IndustrialEngineering/IeMethodStudy.js
//
// THE DRAFT METHOD STUDY — TIMED CYCLES FOR ONE BULLETIN ROW.
//
// A study is the evidence behind a time: somebody stood at the machine, timed
// the operation several times, judged the operator's pace, and wrote down which
// cycles count and why the others do not. This record holds that evidence and
// the two numbers it yields — observed time and normal time.
//
// ── WHY ITS OWN COLLECTION AND NOT AN ARRAY INSIDE THE BULLETIN ─────────────
// A bulletin row has ONE proposed time and MANY studies over its life: the
// operation gets replaced, the method changes, a second engineer re-times it.
// Embedding the observations in `IeStyleFile` would grow the file document on
// every cycle typed, make an unrelated bulletin save rewrite somebody's
// stopwatch sheet, and — the reason that matters — throw the old study away the
// moment the row's operation was replaced, which is exactly when the old
// evidence is most worth keeping.
//
// So a study points AT a bulletin row and is never owned by it. The row can be
// reordered, re-noted, re-timed or removed; the study stays readable and says
// how it now relates to the file (see `applicability` in the service).
//
// ── THE SNAPSHOT IS TAKEN FROM THE ROW, NOT FROM THE LIBRARY ────────────────
// `ieOperationId` / `ieOperationRevision` / code / name / machine type are
// copied from the BULLETIN ROW at creation — which itself preserved them from
// when the row was authored (Chunk 3A). Reading the live library instead would
// make a study claim it timed a revision of the operation that did not exist on
// the day it was timed. Nothing here ever refreshes them.
//
// ── WHAT THIS RECORD MUST NEVER HOLD ────────────────────────────────────────
// No worker name, no employee id, no wage, no payroll allowance and no
// designation. A method study times an OPERATION, not a person: naming the
// operator turns a work-measurement record into a performance file on an
// individual, and the rating below would become a score against their name.
// The rating is a judgement about the observed pace of the work, and that is
// all it is allowed to be.
//
// ── CHUNK 4B: THE LIFECYCLE AND THE FROZEN SUBMISSIONS ──────────────────────
// A study now becomes a STANDARD TIME by being submitted, reviewed by somebody
// else, and approved: DRAFT → IN_REVIEW → APPROVED, with a return path back to
// DRAFT. Each submission attempt is frozen into `submissions[]` — the study as
// it stood, its cycles, its rating, its normal time, the exact allowance policy
// snapshot used, and the standard time that came out. A returned submission is
// never deleted: "we sent this back in September, and here is precisely what we
// sent back" is the whole value of a review trail.
//
// The submissions are EMBEDDED, and that is what makes an approval atomic. The
// study's status, the submission's own status, the revision and the audit event
// are one single-document update, so there is no window in which a study is
// approved and its submission is not, or vice versa. A second collection would
// need a transaction this deployment cannot rely on.
//
// Allowances themselves live in `IeAllowancePolicy` — a company decision with
// an effective date, published by a second person. This record never holds a
// wage, a payroll allowance or a costing figure.
"use strict";

const mongoose = require("mongoose");

/* ── THE WHOLE LIFECYCLE, AND ONLY THESE THREE STATES ─────────────────────
   DRAFT is being written and is the only editable state. IN_REVIEW is frozen
   while somebody else decides. APPROVED is permanent evidence: a standard time
   other people will plan and cost against must not be quietly re-timed
   afterwards. Re-timing means a NEW study, which the partial index below permits
   once this one is APPROVED — and refuses while it is DRAFT or IN_REVIEW. */
const STUDY_STATUS = ["DRAFT", "IN_REVIEW", "APPROVED"];

/** What a submission attempt is now: awaiting a decision, sent back, or accepted. */
const SUBMISSION_STATUS = ["IN_REVIEW", "RETURNED", "APPROVED"];

/** Where an approved standard time came from. Never hidden — see the schema. */
const STANDARD_TIME_SOURCE = ["CALCULATED", "MANUAL_OVERRIDE"];

const EVENT_TYPES = [
  "METHOD_STUDY_CREATED",
  "METHOD_STUDY_EDITED",
  "METHOD_STUDY_SUBMITTED",
  "METHOD_STUDY_RETURNED",
  "METHOD_STUDY_APPROVED",
];

/** How a study relates to the bulletin as it stands NOW. Derived, never stored. */
const APPLICABILITY = ["CURRENT", "OPERATION_CHANGED", "ROW_REMOVED"];

const LIMITS = Object.freeze({
  OBSERVATIONS: 200,
  DURATION_SECONDS: 86400,
  RATING_PERCENT: 500,
  LOCATION: 200,
  NOTE: 1000,
  EXCLUSION_REASON: 500,
  SUMMARY: 300,
  HISTORY: 200,
  /* ── WHY SUBMISSIONS ARE CAPPED, AND WHAT THE CAP DOES ─────────────────
     A study that has been round the review loop fifty times is a process
     problem, not a storage problem, and an unbounded array on a document
     everybody reads is how a collection becomes unreadable. So the cap
     REFUSES a further submission rather than dropping the oldest one: no
     returned submission is ever deleted, which is the rule that matters. */
  SUBMISSIONS: 20,
  REVIEW_NOTE: 1000,
  OVERRIDE_REASON: 1000,
});

/**
 * One timed cycle.
 *
 * `observationId` is minted by the server once and survives every edit, so the
 * third cycle stays the third cycle when the second is deleted — and so an
 * exclusion recorded last week still points at the cycle it was about.
 */
const observationSchema = new mongoose.Schema(
  {
    observationId: { type: String, required: true, trim: true },
    /* A position, not an identity: renumbered on every save. */
    sequence: { type: Number, required: true, min: 1 },

    /* Seconds, because that is what a stopwatch reads. Strictly greater than
       zero — an operation that took no time was not observed. */
    durationSeconds: { type: Number, required: true, min: 0, max: LIMITS.DURATION_SECONDS },

    /* ── INCLUDED CYCLES ARE THE CALCULATION; EXCLUDED ONES ARE THE RECORD ──
       A cycle interrupted by a thread break is still evidence — of the
       interruption. Deleting it would leave the sheet saying eight cycles were
       timed when nine were. So it stays, marked out, with the reason it does
       not count. */
    included: { type: Boolean, default: true },
    exclusionReason: { type: String, trim: true, default: "", maxlength: LIMITS.EXCLUSION_REASON },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
  },
  { _id: false },
);

/**
 * ONE FROZEN SUBMISSION ATTEMPT.
 *
 * Everything needed to re-derive the standard time without reading any other
 * record: the study's own facts as they stood, the complete cycle snapshot, the
 * rating, the normal-time result, and the exact allowance policy — its id, its
 * revision, its name, its effective date and its categories. A policy published
 * next year changes none of this, which is the reason the copy exists.
 *
 * Frozen means frozen: nothing in the service edits a submission after it is
 * pushed, except the single review decision that closes it.
 */
const submissionSchema = new mongoose.Schema(
  {
    submissionId: { type: String, required: true, trim: true },
    /* Which revision of the study was submitted — the version somebody read
       and decided to stand behind. */
    sourceStudyRevision: { type: Number, required: true, min: 1 },

    /* The study's own recorded facts, as submitted. */
    studiedAt: { type: Date, default: null },
    location: { type: String, trim: true, default: "" },
    methodNote: { type: String, trim: true, default: "" },
    evidenceNote: { type: String, trim: true, default: "" },
    ratingPercent: { type: Number, default: null },

    /* The complete cycle sheet. `Mixed`-free but deliberately its own copy: the
       live observations may be edited after a return, and this must not move. */
    observations: {
      type: [new mongoose.Schema({
        observationId: { type: String, required: true },
        sequence: { type: Number, required: true },
        durationSeconds: { type: Number, required: true },
        included: { type: Boolean, default: true },
        exclusionReason: { type: String, trim: true, default: "" },
        note: { type: String, trim: true, default: "" },
      }, { _id: false })],
      default: () => [],
    },

    /* The Chunk 4A result, recomputed and verified server-side at submission. */
    result: {
      includedCycleCount: { type: Number, default: 0 },
      excludedCycleCount: { type: Number, default: 0 },
      averageObservedSeconds: { type: Number, default: null },
      ratingPercent: { type: Number, default: null },
      normalTimeSeconds: { type: Number, default: null },
      normalTimeMinutes: { type: Number, default: null },
      calculationComplete: { type: Boolean, default: false },
    },

    /* ── THE ALLOWANCE POLICY, FROZEN ────────────────────────────────────── */
    allowancePolicy: {
      policyId: { type: mongoose.Schema.Types.ObjectId, default: null },
      policyRevision: { type: Number, default: null },
      name: { type: String, trim: true, default: "" },
      effectiveFrom: { type: Date, default: null },
      categories: {
        type: [new mongoose.Schema({
          categoryId: { type: String, required: true },
          sequence: { type: Number, required: true },
          code: { type: String, trim: true, required: true },
          name: { type: String, trim: true, default: "" },
          percent: { type: Number, required: true },
          note: { type: String, trim: true, default: "" },
        }, { _id: false })],
        default: () => [],
      },
      totalAllowancePercent: { type: Number, default: null },
    },

    /* ── WHAT THE CALCULATION SAID, AND WHAT WAS ASKED FOR INSTEAD ────────
       Both are kept, always. An override does not overwrite the calculated
       figure and does not hide that somebody asked for a different number —
       a reviewer approving a manual time must be able to see what the
       stopwatch and the policy actually produced. */
    calculatedStandardTimeSeconds: { type: Number, default: null },
    calculatedStandardTimeMinutes: { type: Number, default: null },
    manualStandardTimeMinutes: { type: Number, default: null },
    overrideReason: { type: String, trim: true, default: "", maxlength: LIMITS.OVERRIDE_REASON },

    /* The figure this submission is asking to have approved, and where it came
       from. `MANUAL_OVERRIDE` only ever appears alongside a reason. */
    standardTimeSource: { type: String, enum: STANDARD_TIME_SOURCE, default: "CALCULATED" },
    standardTimeSeconds: { type: Number, default: null },
    standardTimeMinutes: { type: Number, default: null },

    submittedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    submittedByName: { type: String, trim: true, default: "" },
    submittedAt: { type: Date, required: true },

    status: { type: String, enum: SUBMISSION_STATUS, default: "IN_REVIEW", required: true },
    /* The decision. `reviewedBy` is an id because maker-checker compares
       identities, never display names. */
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, default: "", maxlength: LIMITS.REVIEW_NOTE },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the observations. */
const studyEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    studyRevision: { type: Number, required: true, min: 1 },
    /* Which KINDS of thing changed — "metadata", "rating", "observations" —
       not the values. The values are on the record; the history says when
       somebody touched them and who. */
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieMethodStudySchema = new mongoose.Schema(
  {
    /* All three from the resolved session context and the owned file — never
       from a request body. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    ieStyleFileId: { type: mongoose.Schema.Types.ObjectId, ref: "IeStyleFile", required: true },
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", required: true },

    /* The bulletin row this study is about, by its stable Chunk 3A row id. */
    bulletinRowId: { type: String, required: true, trim: true },

    /* ── THE ROW'S OPERATION, AS IT WAS WHEN THE STUDY OPENED ────────────── */
    ieOperationId: { type: mongoose.Schema.Types.ObjectId, ref: "IeOperation", required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    machineType: { type: String, trim: true, default: "" },

    status: { type: String, enum: STUDY_STATUS, default: "DRAFT", required: true },
    revision: { type: Number, default: 1, min: 1 },

    /* ── WHAT THE ENGINEER RECORDS ───────────────────────────────────────── */
    studiedAt: { type: Date, default: null },
    location: { type: String, trim: true, default: "", maxlength: LIMITS.LOCATION },
    methodNote: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
    evidenceNote: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    /* Performance rating as a percentage of normal pace: 100 means the
       observed pace WAS normal pace. Null until somebody judges it — and null
       is why a normal time can be absent on a study full of cycles. */
    ratingPercent: { type: Number, default: null, min: 0, max: LIMITS.RATING_PERCENT },

    observations: { type: [observationSchema], default: () => [] },

    /* ── SERVER-CALCULATED, STORED, AND RECOMPUTED ON EVERY WRITE ──────────
       Stored rather than derived at read time so a list of studies can be
       ordered and compared without recomputing each one, and so the numbers a
       reviewer saw are the numbers on the record. Recomputed on every accepted
       write from the observations in the same document, so they cannot drift
       from the evidence. Null where an input is missing — never zero. */
    result: {
      includedCycleCount: { type: Number, default: 0, min: 0 },
      excludedCycleCount: { type: Number, default: 0, min: 0 },
      averageObservedSeconds: { type: Number, default: null },
      ratingPercent: { type: Number, default: null },
      normalTimeSeconds: { type: Number, default: null },
      normalTimeMinutes: { type: Number, default: null },
      calculationComplete: { type: Boolean, default: false },
    },

    /* ── EVERY SUBMISSION ATTEMPT, OLDEST FIRST ───────────────────────────
       Append-only. A returned submission stays for ever; the cap refuses a
       further attempt rather than discarding one. */
    submissions: { type: [submissionSchema], default: () => [] },

    /* The attempt awaiting a decision, if any. Cleared by a return — the
       submission itself stays, marked RETURNED. */
    currentSubmissionId: { type: String, trim: true, default: null },
    /* The attempt that was accepted. Set once and never moved. */
    approvedSubmissionId: { type: String, trim: true, default: null },

    /* ── THE APPROVED STANDARD TIME, FROZEN ONTO THE STUDY ────────────────
       A copy of the accepted submission's figure, so "what is the standard
       time for this operation" is answerable without walking the submissions,
       and so it is queryable. The submission remains the evidence; this is
       the conclusion, and it is written exactly once. */
    approved: {
      submissionId: { type: String, trim: true, default: null },
      standardTimeSeconds: { type: Number, default: null },
      standardTimeMinutes: { type: Number, default: null },
      standardTimeSource: { type: String, enum: [...STANDARD_TIME_SOURCE, null], default: null },
      normalTimeSeconds: { type: Number, default: null },
      totalAllowancePercent: { type: Number, default: null },
      allowancePolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
      at: { type: Date, default: null },
      byName: { type: String, trim: true, default: "" },
    },

    history: { type: [studyEventSchema], default: () => [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_method_studies" },
);

/* ── ONE ACTIVE STUDY PER ROW-OPERATION SNAPSHOT, DECIDED BY THE DATABASE ───
 * Opening a study twice must resume the first one, and "look then insert" is
 * two operations that two simultaneous requests both pass. This index is what
 * actually decides; the loser reads the winner's study and returns it.
 *
 * The key includes the captured OPERATION and its REVISION on purpose. It is
 * deliberately NOT one study per row for all time: replacing a row's operation
 * is a different operation being timed, so it earns its own study, and the
 * previous one stays as the evidence for what it was.
 *
 * ── WHY THE FILTER COVERS IN_REVIEW AND NOT ONLY DRAFT ──────────────────────
 * It covered `status: "DRAFT"` alone, and that was wrong in a way only the
 * review loop exposes: submitting a study makes it IN_REVIEW, which took it out
 * of the filter, so the open endpoint would start a SECOND draft for the same
 * operation — and returning the first one then moved it back into a slot the
 * second already held, failing with a raw duplicate key. The invariant is about
 * being ACTIVE, not about being a draft:
 *
 *   at most one study in DRAFT or IN_REVIEW per
 *   (company, engineering file, bulletin row, operation, operation revision)
 *
 * An APPROVED study leaves the filter for good, and THAT is what permits a
 * genuinely new draft: re-timing an operation whose standard time was approved
 * last season is exactly what a method study is for, and the approved one stays
 * untouched as evidence. While a study is DRAFT or IN_REVIEW, no second study
 * for the same operation can exist at all.
 *
 * `$in` inside a `partialFilterExpression` is not supported by every mongod, so
 * it was PROVED against this deployment's own (7.0.24) rather than assumed —
 * `$ne` is refused there and is deliberately not used.
 */
ieMethodStudySchema.index(
  { companyId: 1, ieStyleFileId: 1, bulletinRowId: 1, ieOperationId: 1, ieOperationRevision: 1 },
  {
    unique: true,
    name: "ie_method_study_one_active_per_row_operation",
    partialFilterExpression: { status: { $in: ["DRAFT", "IN_REVIEW"] } },
  },
);

/* The row's studies, newest first — the list endpoint's own order. */
ieMethodStudySchema.index({ companyId: 1, ieStyleFileId: 1, bulletinRowId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.models.IeMethodStudy
  || mongoose.model("IeMethodStudy", ieMethodStudySchema);
module.exports.STUDY_STATUS = STUDY_STATUS;
module.exports.SUBMISSION_STATUS = SUBMISSION_STATUS;
module.exports.STANDARD_TIME_SOURCE = STANDARD_TIME_SOURCE;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.APPLICABILITY = APPLICABILITY;
module.exports.LIMITS = LIMITS;
