// services/plEligibility.js
//
// Who should hold privilege leave, and what to do when they do not.
//
// WHY THIS IS A FUNCTION AND NOT A BRANCH INSIDE THE ROUTE
// -------------------------------------------------------
// The PL sync used to only grant, and the decision was four lines inside the
// loop. It now REVOKES as well, which means a wrong answer takes an entitlement
// away from somebody — and the cases where it must refuse to act (no date of
// joining, PL already taken) are exactly the ones that are easy to get wrong and
// impossible to notice afterwards. Pulled out here it can be tested against its
// whole decision table without a database, which is the only way to be sure the
// refusals actually fire.
//
// It decides. It does not write anything, and it never reads the clock —
// `workingDays` is passed in, so a test does not have to travel through time.

"use strict";

/**
 * @typedef {"grant"|"revoke"|"already-correct"|"not-yet-eligible"|"needs-review"|"no-joining-date"} PlAction
 */

/**
 * @param {object} input
 * @param {*}       input.dateOfJoining  falsy means "not recorded"
 * @param {number}  input.workingDays    days served, as workingDaysSince computes them
 * @param {number}  input.threshold      config.daysRequiredForPL
 * @param {boolean} input.plEligible     what the balance currently says
 * @param {number}  input.consumedPL     PL days already taken this year
 * @returns {{ action: PlAction, reason: string, shortBy?: number }}
 */
function decidePlEligibility({
  dateOfJoining,
  workingDays = 0,
  threshold = 240,
  plEligible = false,
  consumedPL = 0,
} = {}) {
  // Absent data is not evidence of ineligibility. `workingDaysSince(undefined)`
  // returns 0, which reads as "nowhere near the threshold" and would revoke
  // every employee whose joining date has not been filled in — the same class
  // of mistake this sync exists to clean up, applied to far more people.
  if (!dateOfJoining) {
    return {
      action: "no-joining-date",
      reason:
        "No date of joining on record, so eligibility cannot be worked out. " +
        "Nothing was changed either way.",
    };
  }

  const qualifies = Number(workingDays) >= Number(threshold);

  if (qualifies && plEligible) {
    return { action: "already-correct", reason: "Eligible and already granted." };
  }
  if (!qualifies && !plEligible) {
    return {
      action: "not-yet-eligible",
      reason: `${workingDays} of the ${threshold} working days required.`,
      shortBy: Number(threshold) - Number(workingDays),
    };
  }
  if (qualifies && !plEligible) {
    return {
      action: "grant",
      reason: `${workingDays} working days served, past the ${threshold} required.`,
    };
  }

  // !qualifies && plEligible — they hold PL the dates do not support.
  const taken = Number(consumedPL) || 0;
  if (taken > 0) {
    // Zeroing the entitlement here would leave consumed above entitlement:
    // leave that was applied for, approved, and in most cases already paid.
    // Whether those days become LWP, stand as an exception, or are recovered is
    // a payroll decision with money attached. A sync button does not get to
    // make it.
    return {
      action: "needs-review",
      shortBy: Number(threshold) - Number(workingDays),
      reason:
        `Holds PL but has only ${workingDays} of the ${threshold} working days required, ` +
        `and has already taken ${taken} PL day(s). Those days need a decision before ` +
        `the entitlement can be removed.`,
    };
  }

  return {
    action: "revoke",
    shortBy: Number(threshold) - Number(workingDays),
    reason:
      `Holds PL but has only ${workingDays} of the ${threshold} working days required, ` +
      `and has taken none of it. Usually means the date of joining was corrected ` +
      `after the PL was granted.`,
  };
}

module.exports = { decidePlEligibility };
