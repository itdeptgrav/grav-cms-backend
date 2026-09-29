// services/industrialEngineering/standardTimeCalculation.js
//
// NORMAL TIME + ALLOWANCES = STANDARD TIME. THE WHOLE STEP, AND NOTHING ELSE.
//
// Pure, like its Chunk 4A neighbour: no database, no request, no clock. The
// figure this returns is what a line is balanced against and what a costing
// will eventually be told, so the arithmetic lives where somebody can check it
// against a sheet of paper.
//
// ── THE FORMULA FOR THIS RELEASE ────────────────────────────────────────────
//   totalAllowancePercent = Σ(policy category percentages)
//   standardTimeSeconds   = normalTimeSeconds × (1 + totalAllowancePercent/100)
//   standardTimeMinutes   = standardTimeSeconds ÷ 60
//
// Allowances are ADDED to normal time as a percentage. That is the simple
// convention, stated in the task and written down here rather than assumed: the
// other one in the trade divides by (1 − allowance/100), which gives a bigger
// number for the same percentage. Nothing in this codebase may use the two
// interchangeably, so the multiplication appears exactly once, here.
//
// ── WHAT IT NEVER READS ─────────────────────────────────────────────────────
// No wage, no payroll allowance, no material or costing allowance field. The
// only allowances in scope are the categories of an IE allowance policy that a
// second person published.
//
// ── AND MISSING IS NULL, NEVER ZERO ─────────────────────────────────────────
// No normal time, or no policy, means there is no standard time — not a
// standard time of zero. A zero would be consumed by anything downstream as a
// real figure, and an operation that takes no time is a claim nobody made.
"use strict";

/** Four decimal places, one rounding, always the same direction. */
const round4 = (n) => Math.round(n * 10000) / 10000;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The total of a policy's categories.
 *
 * Summed in stored order and rounded ONCE, so the total does not depend on the
 * order somebody typed the categories in. An empty list totals 0 — a published
 * policy with no categories is a deliberate 0% policy, which is a decision, and
 * is not the same as having no policy at all.
 */
function totalAllowancePercentOf(categories = []) {
  const rows = Array.isArray(categories) ? categories : [];
  const usable = rows.filter((c) => c && isFiniteNumber(c.percent));
  if (usable.length !== rows.length) return null;
  return round4(usable.reduce((sum, c) => sum + c.percent, 0));
}

/**
 * @param {number?} input.normalTimeSeconds      from the saved Chunk 4A result
 * @param {number?} input.totalAllowancePercent  from the frozen policy snapshot
 */
function calculateStandardTime({ normalTimeSeconds = null, totalAllowancePercent = null } = {}) {
  const normal = isFiniteNumber(normalTimeSeconds) ? normalTimeSeconds : null;
  const allowance = isFiniteNumber(totalAllowancePercent) ? totalAllowancePercent : null;

  if (normal === null || allowance === null) {
    return {
      totalAllowancePercent: allowance === null ? null : round4(allowance),
      standardTimeSeconds: null,
      standardTimeMinutes: null,
      calculationComplete: false,
    };
  }

  /* Rounded once, at the end. */
  const standardTimeSeconds = round4(normal * (1 + allowance / 100));
  return {
    totalAllowancePercent: round4(allowance),
    standardTimeSeconds,
    /* Derived from the ROUNDED seconds, so the two published figures always
       agree: minutes × 60 is the seconds shown. */
    standardTimeMinutes: round4(standardTimeSeconds / 60),
    calculationComplete: true,
  };
}

module.exports = { calculateStandardTime, totalAllowancePercentOf, round4 };
