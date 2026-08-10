// services/leadReview.js
//
// The ONE place that writes Lead.reviewStatus (the Prospect → HOD Review →
// Active Lead workflow — see the model + constants/crm.js block comments).
// Same "single writer" discipline as services/leadQualification.js: no other
// code path may set reviewStatus, so the state machine can't be bypassed and
// "only a HOD/admin approval turns a Prospect into an Active Lead" is true by
// construction.
//
// Division of labour, mirroring leadQualification.js:
//   • This module validates the STATE transition and stamps the review side
//     of the Lead (reviewStatus + audit fields), purely in memory. It does
//     NOT save(), and it does NOT do authorization (which needs req.user) —
//     the route layer (routes/CMS_Routes/Sales/leads.js) checks isSalesManager
//     and orchestrates the captureStatus flip + first-Activity creation that
//     `approve`/`reject` imply. That keeps this file DB-free and unit-testable.
//   • `approve` deliberately does NOT flip captureStatus here — the route does
//     that as part of its create-Activity-then-flip reliability pattern (the
//     same one the old activate path used). This function only records that
//     the review was approved.
//
// The four transitions, and who the route restricts each to:
//   submit  (researching|returned → submitted)  — the Prospect's owner/creator
//   approve (submitted → approved)               — HOD/admin only
//   return  (submitted → returned)               — HOD/admin only, reason req.
//   reject  (submitted → rejected)               — HOD/admin only, reason req.
"use strict";

/** A 4xx the caller can act on, as opposed to an unexpected 500. */
class LeadReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "LeadReviewError";
    this.status = status;
  }
}

// A missing reviewStatus (a Prospect captured before this workflow existed)
// reads as "researching" — the accurate meaning for one nobody has submitted.
const currentReview = (lead) => lead.reviewStatus || "researching";

// Submit is allowed from the two "with the salesperson" states only.
const SUBMITTABLE_FROM = new Set(["researching", "returned"]);

/**
 * Submit a Prospect for HOD review. researching|returned → submitted.
 * Only a Prospect (captureStatus:"draft") can be submitted; readiness
 * (services/leadReadiness.js computeSubmissionReadiness) is enforced by the
 * route BEFORE calling this — this function is the state guard, not the
 * content check.
 */
function applySubmit(lead, { actor } = {}) {
  if (lead.captureStatus !== "draft") {
    throw new LeadReviewError("Only a Prospect can be submitted for HOD review.");
  }
  if (!SUBMITTABLE_FROM.has(currentReview(lead))) {
    throw new LeadReviewError(
      `A Prospect can only be submitted while Researching or Returned (it is currently "${currentReview(lead)}").`,
    );
  }
  lead.reviewStatus = "submitted";
  lead.submittedAt = new Date();
  lead.submittedBy = actor;
  lead.reviewReason = undefined; // clear any prior return/reject reason
  if (actor) lead.updatedBy = actor;
}

/** Every HOD action requires a Prospect that is actually awaiting review. */
function assertAwaitingReview(lead) {
  if (lead.captureStatus !== "draft" || currentReview(lead) !== "submitted") {
    throw new LeadReviewError("Only a Prospect awaiting HOD review can be actioned.");
  }
}

/**
 * Approve a submitted Prospect as an Active Lead. submitted → approved.
 * Records the review outcome ONLY — the route flips captureStatus to "active"
 * and creates the first Activity (its reliability pattern), and may apply the
 * HOD's optional owner override before saving.
 */
function applyApprove(lead, { actor } = {}) {
  assertAwaitingReview(lead);
  lead.reviewStatus = "approved";
  lead.reviewedAt = new Date();
  lead.reviewedBy = actor;
  lead.reviewReason = undefined;
  if (actor) lead.updatedBy = actor;
}

/**
 * Return a submitted Prospect for more information. submitted → returned.
 * A reason is required (it's shown to the salesperson so they know what to
 * add). Stays a Prospect (captureStatus unchanged) and becomes editable /
 * re-submittable again.
 */
function applyReturn(lead, { reason, actor } = {}) {
  assertAwaitingReview(lead);
  if (!String(reason || "").trim()) {
    throw new LeadReviewError("A reason is required to return a Prospect for more information.");
  }
  lead.reviewStatus = "returned";
  lead.reviewReason = String(reason).trim();
  lead.reviewedAt = new Date();
  lead.reviewedBy = actor;
  if (actor) lead.updatedBy = actor;
}

/**
 * Reject a submitted Prospect. submitted → rejected, and the Prospect is
 * archived (captureStatus → "archived" — reject IS archive, per the spec's
 * "Reject/Archive"). A reason is required. Sets the draft-archive audit
 * fields too, so a rejected Prospect is exactly as disposed as one archived
 * directly. captureStatus is flipped HERE (unlike approve) because reject has
 * no Activity to create first — there's no reliability ordering to preserve.
 */
function applyReject(lead, { reason, actor } = {}) {
  assertAwaitingReview(lead);
  if (!String(reason || "").trim()) {
    throw new LeadReviewError("A reason is required to reject a Prospect.");
  }
  lead.reviewStatus = "rejected";
  lead.reviewReason = String(reason).trim();
  lead.reviewedAt = new Date();
  lead.reviewedBy = actor;
  lead.captureStatus = "archived";
  lead.draftArchivedAt = new Date();
  lead.draftArchivedBy = actor;
  if (actor) lead.updatedBy = actor;
}

module.exports = {
  LeadReviewError,
  applySubmit,
  applyApprove,
  applyReturn,
  applyReject,
};
