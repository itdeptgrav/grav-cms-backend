// services/leadQualification.js
//
// The ONE place that writes Lead.qualificationState and/or Lead.stage. Every
// entry point that can change either field — the canonical
// PATCH /:id/qualification-state, the legacy PATCH /:id/stage, the generic
// POST //PATCH /:id create/update (when a `stage` value actually changes),
// and routes/CMS_Routes/Sales/callSchedule.js's call-completion flow — goes
// through the functions here. That is what makes "stage and qualificationState
// cannot contradict each other" true by construction rather than by
// convention: there is no second code path left that can set either field on
// its own.
//
// THREE OPERATIONS, THREE FUNCTIONS:
//
//   resolveInitialQualification — Lead CREATION only. Not a "transition" (a
//     brand-new record has no prior state to transition from), so it is not
//     checked against LEAD_QUALIFICATION_TRANSITIONS. It only checks that the
//     requested legacy stage is one that still means something
//     (LEGACY_LEAD_STAGE_TO_QUALIFICATION) and isn't one of the blocked
//     values, and that a reason is present if the resolved state requires one.
//
//   applyQualificationTransition — the canonical transition, used directly by
//     PATCH /:id/qualification-state and internally by applyLegacyStageChange
//     below. Validates the enum, refuses `converted`, refuses any move once a
//     Lead is already `converted`, checks LEAD_QUALIFICATION_TRANSITIONS for
//     the specific from→to move, requires a reason where the vocabulary
//     demands one, then updates BOTH qualificationState and — via
//     deriveLegacyStage — `stage`, on the same object, in one place.
//
//   applyLegacyStageChange — the legacy-compatible wrapper used by
//     PATCH /:id/stage, the generic PATCH /:id (when `stage` changes), and
//     callSchedule.js. Translates an incoming legacy stage name through
//     LEGACY_LEAD_STAGE_TO_QUALIFICATION (rejecting BLOCKED_LEGACY_LEAD_STAGES
//     outright) and then calls applyQualificationTransition with the result.
//     Also short-circuits to a no-op when the submitted stage already equals
//     the Lead's current stage — "an existing legacy record submits its
//     unchanged stage while editing another field" must never be treated as
//     an attempted transition.
"use strict";

const {
  LEAD_QUALIFICATION_STATE_CODES,
  LEAD_QUALIFICATION_REASON_REQUIRED,
  LEAD_QUALIFICATION_RESERVED_STATES,
  LEAD_QUALIFICATION_TRANSITIONS,
  LEGACY_LEAD_STAGE_TO_QUALIFICATION,
  BLOCKED_LEGACY_LEAD_STAGES,
  LEAD_QUALIFICATION_TO_LEGACY_STAGE,
} = require("../constants/crm");
const { computeQualificationReadiness, hasSpecificCredibleRequirement, hasContactRoute } = require("./leadReadiness");

/** A 4xx the caller can act on, as opposed to an unexpected 500. */
class LeadTransitionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "LeadTransitionError";
    this.status = status;
  }
}

/** Is `from → to` one of the explicitly permitted canonical moves? */
function isValidTransition(from, to) {
  const allowed = LEAD_QUALIFICATION_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * The legacy `stage` value that should be shown once a Lead is at
 * `qualificationState`. `nurture` is a deliberate pass-through: it is
 * orthogonal to the legacy funnel position, so the Lead's existing `stage`
 * (whatever it was before entering nurture) is left alone rather than
 * invented.
 */
function deriveLegacyStage(qualificationState, previousStage) {
  if (qualificationState === "nurture") return previousStage;
  return LEAD_QUALIFICATION_TO_LEGACY_STAGE[qualificationState] ?? previousStage;
}

/**
 * Apply a canonical state change to an in-memory Lead document. Does not
 * save() — the caller controls that, so it can be combined with other field
 * updates in one write. Throws LeadTransitionError, and never partially
 * mutates the document, on any invalid input.
 *
 * Every per-target PREREQUISITE lives here, not just in the frontend, so the
 * rule holds no matter which entry point reaches a given target — the
 * canonical PATCH /:id/qualification-state, the legacy PATCH /:id/stage (via
 * applyLegacyStageChange below), and any future caller. Two of those
 * prerequisites genuinely need the database (has this Lead had a logged
 * outreach attempt / a successful contact? does the referenced duplicate
 * record actually exist?) — this function stays pure and DB-free by having
 * the CALLER answer those as plain booleans in `context`, the same split
 * services/leadReadiness.js already uses for its own DB-dependent check.
 *
 * @param {import("mongoose").Document} lead
 * @param {object} opts
 * @param {string} opts.qualificationState  the target canonical state
 * @param {string} [opts.reason]            required for nurture/disqualified/duplicate
 * @param {object} [opts.actor]             { id, name } — stamped onto updatedBy
 * @param {object} [opts.nextAction]        { subject, dueDate } — required for nurture
 * @param {object} [opts.context]           DB-dependent facts the route already checked:
 *   {boolean} [hasOutreachAttempt]   required true to reach "contactAttempted"
 *   {boolean} [hasSuccessfulContact] required true to reach "contacted"
 *   {{type,id}} [duplicateTarget]    the verified-to-exist Lead/Account, required for "duplicate"
 */
function applyQualificationTransition(lead, { qualificationState, reason, actor, nextAction, context = {} } = {}) {
  // Draft Lead chunk: a Draft cannot move through qualification states at
  // all — it stays at the schema default ("new") until POST /:id/activate
  // flips captureStatus to "active" (see routes/CMS_Routes/Sales/leads.js).
  // Checked first, before the target is even validated, so the message is
  // about the REAL reason this was refused rather than a generic "invalid
  // transition".
  if (lead.captureStatus === "draft") {
    throw new LeadTransitionError("Prospects cannot move through qualification states — get the Prospect approved as an Active Lead first.");
  }
  if (!LEAD_QUALIFICATION_STATE_CODES.includes(qualificationState)) {
    throw new LeadTransitionError(
      `qualificationState must be one of: ${LEAD_QUALIFICATION_STATE_CODES.join(", ")}`,
    );
  }
  if (LEAD_QUALIFICATION_RESERVED_STATES.has(qualificationState)) {
    throw new LeadTransitionError(
      "converted is set by the Lead conversion service only, and is not implemented in this chunk.",
    );
  }
  if (lead.qualificationState === "converted") {
    throw new LeadTransitionError("This Lead has already converted and cannot be re-qualified.");
  }
  if (!isValidTransition(lead.qualificationState, qualificationState)) {
    throw new LeadTransitionError(
      `Cannot move a Lead from "${lead.qualificationState}" to "${qualificationState}".`,
    );
  }

  // Contacting / Engaged — you cannot have contacted a Lead you have no way to
  // reach. Enforced BEFORE the activity checks so the message names the real
  // gap (no phone/WhatsApp/email on file) rather than "log an outreach first".
  // This is what stops "I pressed the button saying I called" on a record that
  // carries no contact channel at all.
  if ((qualificationState === "contactAttempted" || qualificationState === "contacted") && !hasContactRoute(lead)) {
    throw new LeadTransitionError(
      "This Lead has no contact details yet — add a phone number, WhatsApp or email before marking it Contacting or Engaged.",
    );
  }
  // Contacting — needs a genuinely logged outreach attempt (any completed
  // call/email/meeting/site visit), not just a button click.
  if (qualificationState === "contactAttempted" && !context.hasOutreachAttempt) {
    throw new LeadTransitionError(
      "Contacting requires a logged outreach attempt (call, email, meeting or site visit) on this Lead.",
    );
  }
  // Engaged — needs a genuinely SUCCESSFUL two-way contact outcome, a higher
  // bar than merely having attempted.
  if (qualificationState === "contacted" && !context.hasSuccessfulContact) {
    throw new LeadTransitionError(
      "Engaged requires a successful two-way contact outcome (Replied / Connected or Meeting Completed) logged on this Lead.",
    );
  }
  // Ready for Journey — its OWN extra gate on top of Qualified's checklist: a
  // SPECIFIC, CREDIBLE requirement must exist (confirmed product, quantity and
  // required-by date). Checked first so this dedicated rule is what speaks.
  if (qualificationState === "readyToConvert" && !hasSpecificCredibleRequirement(lead)) {
    throw new LeadTransitionError(
      "Ready for Journey needs a specific, credible requirement — a confirmed product, quantity and required-by date on this Lead.",
    );
  }
  // Qualified / Ready for Journey — both must clear the qualification checklist
  // bar; Ready for Journey re-confirms it still holds (and adds the credible-
  // requirement gate above), not a second, stricter list.
  if (qualificationState === "qualified" || qualificationState === "readyToConvert") {
    const { checks, ready } = computeQualificationReadiness(lead);
    if (!ready) {
      const missing = checks.filter((c) => !c.met).map((c) => c.label).join("; ");
      throw new LeadTransitionError(
        `This Lead isn't ready for "${qualificationState}" yet — missing: ${missing}.`,
      );
    }
  }
  // Duplicate — needs a GENUINE, verified-to-exist Lead/Account link, not
  // just a reason string.
  let duplicateOf;
  if (qualificationState === "duplicate") {
    if (!context.duplicateTarget || !context.duplicateTarget.id) {
      throw new LeadTransitionError(
        "Duplicate requires linking this Lead to the existing Lead or Account it duplicates.",
      );
    }
    duplicateOf = context.duplicateTarget;
  }

  const reasonRequired = LEAD_QUALIFICATION_REASON_REQUIRED.has(qualificationState);
  if (reasonRequired && !String(reason || "").trim()) {
    throw new LeadTransitionError(`A reason is required to set qualificationState to "${qualificationState}".`);
  }
  // Nurture — needs a next action and a FUTURE revisit date (a follow-up plan
  // that actually parks the Lead until a later date), not just a reason.
  if (qualificationState === "nurture") {
    if (!String(nextAction?.subject || "").trim()) {
      throw new LeadTransitionError("Nurture requires a next action.");
    }
    if (!nextAction?.dueDate) {
      throw new LeadTransitionError("Nurture requires a follow-up date.");
    }
    if (new Date(nextAction.dueDate).getTime() <= Date.now()) {
      throw new LeadTransitionError("Nurture's revisit date must be in the future.");
    }
  }

  lead.qualificationState = qualificationState;
  lead.qualificationReason = reasonRequired ? String(reason).trim() : undefined;
  lead.stage = deriveLegacyStage(qualificationState, lead.stage);
  if (duplicateOf) lead.duplicateOf = duplicateOf;
  if (actor) lead.updatedBy = actor;
}

/**
 * The ONE rule for whether a Lead may start a Sales Journey — checked by
 * routes/CMS_Routes/Sales/salesJourneys.js's POST /:id (via `sourceLeadId`)
 * before it creates anything. This is deliberately NOT wired into
 * applyQualificationTransition/LEAD_QUALIFICATION_TRANSITIONS: `converted` stays
 * refused on the general PATCH /:id/qualification-state endpoint (see
 * LEAD_QUALIFICATION_RESERVED_STATES above) so a client can never set it by
 * hand. The Sales Journey route is the ONLY caller that may act on this check
 * and flip the Lead — see that file for the atomic, race-safe write. Pure —
 * throws or returns, never mutates.
 */
function assertLeadConvertible(lead) {
  if (lead.captureStatus === "draft") {
    throw new LeadTransitionError("Prospects cannot start a Sales Journey — get the Prospect approved as an Active Lead first.");
  }
  if (lead.qualificationState === "converted") {
    throw new LeadTransitionError("This Lead has already started a Sales Journey.");
  }
  if (lead.qualificationState !== "readyToConvert") {
    throw new LeadTransitionError('Only a Lead that is "Ready for Journey" can start a Sales Journey.');
  }
}

/**
 * Translate an incoming LEGACY stage request into a canonical target, or
 * throw if it can no longer be assigned directly. Pure — does not touch a
 * Lead document.
 */
function resolveLegacyStageRequest(stage, { reason, lostReason } = {}) {
  if (BLOCKED_LEGACY_LEAD_STAGES.has(stage)) {
    throw new LeadTransitionError(
      `"${stage}" can no longer be assigned directly. Proposal, negotiation and won outcomes belong to the ` +
        "Sales Journey once a Lead converts (the conversion service is not implemented in this chunk).",
    );
  }
  const qualificationState = LEGACY_LEAD_STAGE_TO_QUALIFICATION[stage];
  if (!qualificationState) {
    throw new LeadTransitionError(`Unrecognized stage "${stage}".`);
  }
  return { qualificationState, reason: reason || lostReason };
}

/**
 * The legacy-compatible entry point: PATCH /:id/stage, the generic
 * PATCH /:id when `stage` is present and different, and callSchedule.js.
 * Returns `false` (no-op, nothing mutated) when `stage` already equals the
 * Lead's current stage — an unchanged resubmission is not a transition
 * attempt. Returns `true` when a transition was applied. Throws
 * LeadTransitionError for a disallowed or invalid move.
 *
 * Also mirrors the resolved reason onto the legacy `lostReason` field when
 * the request came in as `lost`, so anything still reading that field
 * directly keeps seeing something sensible.
 */
function applyLegacyStageChange(lead, { stage, reason, lostReason, actor, context } = {}) {
  if (stage === lead.stage) return false;
  const resolved = resolveLegacyStageRequest(stage, { reason, lostReason });
  applyQualificationTransition(lead, { qualificationState: resolved.qualificationState, reason: resolved.reason, actor, context });
  if (stage === "lost") lead.lostReason = resolved.reason;
  return true;
}

/**
 * Lead CREATION only — not a transition (no prior state exists). Resolves an
 * optional client-submitted legacy `stage` into the initial
 * {qualificationState, qualificationReason, stage} a new Lead should be
 * created with. Defaults to canonical/legacy "new" when no stage is given or
 * it is already "new". Throws LeadTransitionError for a blocked/unrecognized
 * stage or a missing required reason — called BEFORE the document is
 * created, so an invalid request never persists a partial Lead.
 */
function resolveInitialQualification(stageInput, { reason, lostReason } = {}) {
  if (!stageInput || stageInput === "new") {
    return { qualificationState: "new", qualificationReason: undefined, stage: "new" };
  }
  const resolved = resolveLegacyStageRequest(stageInput, { reason, lostReason });
  const reasonRequired = LEAD_QUALIFICATION_REASON_REQUIRED.has(resolved.qualificationState);
  if (reasonRequired && !String(resolved.reason || "").trim()) {
    throw new LeadTransitionError(
      `A reason is required to create a Lead directly at "${resolved.qualificationState}".`,
    );
  }
  return {
    qualificationState: resolved.qualificationState,
    qualificationReason: reasonRequired ? String(resolved.reason).trim() : undefined,
    stage: deriveLegacyStage(resolved.qualificationState, "new"),
  };
}

module.exports = {
  LeadTransitionError,
  isValidTransition,
  deriveLegacyStage,
  applyQualificationTransition,
  assertLeadConvertible,
  resolveLegacyStageRequest,
  applyLegacyStageChange,
  resolveInitialQualification,
};
