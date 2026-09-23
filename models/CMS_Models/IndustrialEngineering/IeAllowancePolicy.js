// models/CMS_Models/IndustrialEngineering/IeAllowancePolicy.js
//
// THE COMPANY ALLOWANCE POLICY — EFFECTIVE-DATED, PUBLISHED, IMMUTABLE.
//
// An allowance is how much longer than the normal time a job actually takes:
// the operator drinks water, the machine needs threading, the bundle has to be
// fetched. Those percentages are a COMPANY DECISION, not an engineer's opinion
// per study, so they live in one place, are approved by somebody other than
// their author, and carry the date from which they apply.
//
// ── WHY EFFECTIVE-DATED AND NEVER EDITED ────────────────────────────────────
// A standard time approved in September was calculated against September's
// allowances. If the policy were a mutable row, raising the personal allowance
// next year would silently restate every standard time ever approved — and the
// numbers on last season's costings would change with nobody's signature
// against them. So a published policy is frozen for ever, a new one is a NEW
// record with its own effective date, and the old one stays as the reason the
// old figure was what it was.
//
// The applicable policy for a date is the published one with the latest
// `effectiveFrom` that is not after it. Deliberately not "the newest policy":
// a study timed in September must be priced on September's rules even if it is
// submitted in December.
//
// ── AND EVERY SUBMISSION KEEPS ITS OWN COPY ─────────────────────────────────
// Even this record is not what a standard time is calculated from at read time.
// `IeMethodStudy` freezes the whole policy snapshot into each submission, so an
// approved standard time can be re-derived from the submission alone, without
// this collection existing at all.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// No retirement and no deletion — this chunk adds neither, because a policy a
// frozen submission points at must stay readable. No payroll, wage or costing
// allowance: those are other departments' numbers and mean different things.
"use strict";

const mongoose = require("mongoose");

/* DRAFT is being written; PUBLISHED is a decision and is immutable. There is no
   third state in this chunk — no retirement, no supersession flag. A newer
   effective date is what supersedes an older policy, and the dates say so. */
const POLICY_STATUS = ["DRAFT", "PUBLISHED"];

const EVENT_TYPES = [
  "ALLOWANCE_POLICY_CREATED",
  "ALLOWANCE_POLICY_EDITED",
  "ALLOWANCE_POLICY_PUBLISHED",
];

const LIMITS = Object.freeze({
  CATEGORIES: 30,
  CODE: 40,
  NAME: 200,
  NOTE: 500,
  PERCENT: 100,
  TOTAL_PERCENT: 100,
  SUMMARY: 300,
  HISTORY: 200,
});

/**
 * One allowance category.
 *
 * `categoryId` is minted by the server once and survives editing and
 * reordering, so a frozen submission's snapshot can be lined up against the
 * policy it came from even after the categories were renamed.
 */
const categorySchema = new mongoose.Schema(
  {
    categoryId: { type: String, required: true, trim: true },
    /* A position, not an identity: renumbered from the array on every save. */
    sequence: { type: Number, required: true, min: 1 },
    code: { type: String, required: true, trim: true, maxlength: LIMITS.CODE },
    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME },
    /* Percent of normal time. Bounded at 100 per category, and the TOTAL is
       bounded at 100 too — an allowance that doubles every standard time in the
       factory is a typo, and it would be discovered in a costing rather than
       here. */
    percent: { type: Number, required: true, min: 0, max: LIMITS.PERCENT },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the categories. */
const policyEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    policyRevision: { type: Number, required: true, min: 1 },
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieAllowancePolicySchema = new mongoose.Schema(
  {
    /* From the resolved session context only — never from a body. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME },

    /* The date this policy starts applying to studies. Stored as a date; the
       service normalises it to midnight UTC so "1 September" is one value
       whatever time zone typed it, and so the unique index below can hold
       "one published policy per effective date" honestly. */
    effectiveFrom: { type: Date, required: true },

    categories: { type: [categorySchema], default: () => [] },

    /* Server-calculated and stored, recomputed on every accepted write, so a
       reader never sums the categories itself and gets a different answer. */
    totalAllowancePercent: { type: Number, default: 0, min: 0, max: LIMITS.TOTAL_PERCENT },

    status: { type: String, enum: POLICY_STATUS, default: "DRAFT", required: true },
    revision: { type: Number, default: 1, min: 1 },

    /* ── MAKER-CHECKER IDENTITY ────────────────────────────────────────────
       Ids, not names: a display name is not an identity, two people share one,
       and a rename would quietly hand somebody the right to approve their own
       work. `updatedBy` is the LAST EDITOR, which is the second person the
       publisher must not be. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    publishedByName: { type: String, trim: true, default: "" },
    publishedAt: { type: Date, default: null },

    history: { type: [policyEventSchema], default: () => [] },
  },
  { timestamps: true, collection: "ie_allowance_policies" },
);

/* ── ONE DRAFT PER COMPANY ──────────────────────────────────────────────────
 * Partial on DRAFT, so a company may hold as many PUBLISHED policies as it has
 * effective dates but only ever one unfinished one. Enforced by the database
 * because "look for a draft, create one if absent" is two operations that two
 * simultaneous requests both pass. */
ieAllowancePolicySchema.index(
  { companyId: 1, status: 1 },
  { unique: true, name: "ie_allowance_policy_one_draft_per_company", partialFilterExpression: { status: "DRAFT" } },
);

/* ── ONE PUBLISHED POLICY PER EFFECTIVE DATE ────────────────────────────────
 * Two published policies effective the same day would make "which rules
 * applied on the 1st" unanswerable, and something would have to guess. The
 * index refuses it, so a race between two publishes cannot create the
 * ambiguity either. */
ieAllowancePolicySchema.index(
  { companyId: 1, effectiveFrom: 1 },
  {
    unique: true,
    name: "ie_allowance_policy_one_published_per_effective_date",
    partialFilterExpression: { status: "PUBLISHED" },
  },
);

/* The effective-policy lookup: this company's published policies, newest
   effective date first. */
ieAllowancePolicySchema.index({ companyId: 1, status: 1, effectiveFrom: -1 });

module.exports = mongoose.models.IeAllowancePolicy
  || mongoose.model("IeAllowancePolicy", ieAllowancePolicySchema);
module.exports.POLICY_STATUS = POLICY_STATUS;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
