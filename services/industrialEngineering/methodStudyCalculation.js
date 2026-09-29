// services/industrialEngineering/methodStudyCalculation.js
//
// OBSERVED TIME AND NORMAL TIME — THE WHOLE CALCULATION, AND NOTHING ELSE.
//
// Pure: no database, no request, no clock. It takes the observations and the
// performance rating and returns the numbers. That is deliberate — the one
// piece of this chunk a person will check by hand against a stopwatch sheet is
// the arithmetic, so it lives where it can be read and tested on its own.
//
// ── THE FORMULA, AS INDUSTRIAL ENGINEERING WRITES IT ────────────────────────
//   averageObservedSeconds = Σ(included durationSeconds) ÷ includedCycleCount
//   normalTimeSeconds      = averageObservedSeconds × ratingPercent ÷ 100
//   normalTimeMinutes      = normalTimeSeconds ÷ 60
//
// A rating of 100 means the operator was working at normal pace, so normal time
// equals observed time. Above 100 says they were working faster than normal and
// the standard must therefore be LONGER than what was observed; below 100 says
// the opposite. Getting that direction backwards is the classic error, so the
// multiplication is written once, here.
//
// ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
// There is no allowance and no standard time. Normal time plus allowances is
// standard time, and the allowance conventions are a Chunk 4B decision nobody
// has made yet — computing a "standard" from a guessed allowance would put a
// number on an engineering document that no policy backs. Nothing here reads a
// wage, a payroll allowance, a material cost or a costing field.
//
// ── AND MISSING IS NULL, NEVER ZERO ─────────────────────────────────────────
// A study with no included cycles has no average — not an average of zero. A
// study with no rating has no normal time. Zero is a measurement someone could
// have taken; null is the absence of one, and a screen that cannot tell them
// apart will show "0.0000 min" for an empty study and read as a finished one.
"use strict";

/** Four decimal places, one rounding, always the same direction. */
const round4 = (n) => Math.round(n * 10000) / 10000;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {object}   input
 * @param {Array}    input.observations   [{ durationSeconds, included }]
 * @param {number?}  input.ratingPercent  performance rating, or null
 */
function calculateMethodStudy({ observations = [], ratingPercent = null } = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  const included = rows.filter((o) => o && o.included !== false && isFiniteNumber(o.durationSeconds));
  const excluded = rows.length - included.length;

  const includedCycleCount = included.length;
  const excludedCycleCount = excluded;

  /* Summed in stored order and rounded ONCE at the end. Rounding each addition
     would make the total depend on the order the cycles were typed in. */
  const averageObservedSeconds = includedCycleCount
    ? round4(included.reduce((sum, o) => sum + o.durationSeconds, 0) / includedCycleCount)
    : null;

  const rating = isFiniteNumber(ratingPercent) ? ratingPercent : null;

  const normalTimeSeconds = averageObservedSeconds !== null && rating !== null
    ? round4((averageObservedSeconds * rating) / 100)
    : null;

  /* Derived from the ROUNDED seconds rather than from the raw product, so the
     two published figures always agree: minutes × 60 is the seconds shown. */
  const normalTimeMinutes = normalTimeSeconds !== null ? round4(normalTimeSeconds / 60) : null;

  return {
    includedCycleCount,
    excludedCycleCount,
    averageObservedSeconds,
    ratingPercent: rating,
    normalTimeSeconds,
    normalTimeMinutes,
    /* Complete means "every input this calculation needs is present" — at
       least one included cycle AND a rating. It says nothing about whether the
       study is finished, which is a lifecycle question Chunk 4B owns. */
    calculationComplete: includedCycleCount > 0 && rating !== null,
  };
}

module.exports = { calculateMethodStudy, round4 };
