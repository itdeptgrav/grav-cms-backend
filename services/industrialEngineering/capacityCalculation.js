// services/industrialEngineering/capacityCalculation.js
//
// IE CHUNK 7A — THE DETERMINISTIC CAPACITY CALCULATION.
//
// One pure function. Same inputs, same outputs, for ever — it reads no clock,
// no database and no configuration, so a target quoted in October can be
// re-derived in March from the frozen record alone.
//
//   net minutes per shift            = availableShiftMinutes − breakMinutes
//   available operator minutes/shift = netMinutesPerShift × plannedOperatorCount
//   target pieces per hour           = plannedOperatorCount × 60 × efficiency / SAM
//   theoretical pieces per shift     = availableOperatorMinutes × efficiency / SAM
//   whole-piece shift target         = floor(theoretical pieces per shift)
//   theoretical pieces per day       = theoreticalPiecesPerShift × shiftsPerDay
//   whole-piece daily target         = floor(theoretical pieces per day)
//
// ── EFFICIENCY IS A PERCENTAGE ON THE WAY IN, A RATIO ONLY INSIDE ───────────
// The stored and published field is `targetEfficiencyPercent`. It is divided by
// 100 exactly once, here, at the top. Nothing else in the chunk holds a ratio,
// so no reader ever has to work out which of the two a number is.
//
// ── THE PRECISION RULE, STATED ONCE ─────────────────────────────────────────
// Every quantity is computed in EXACT INTEGER TEN-THOUSANDTHS of a minute and
// divided in full precision. Nothing is rounded on the way through: rounding a
// net-minutes figure and then multiplying it by an operator count and a shift
// count compounds the error into whole pieces a day. The single rounding
// happens once, at the response boundary, and it is HALF_UP_4DP — the same
// policy Chunk 6A's balance publishes under, deliberately, so two IE numbers on
// one screen cannot be rounded two different ways.
//
// The whole-piece targets are a different rule and are NOT rounded: they are
// FLOORED. A production target is a commitment somebody works against, and a
// target rounded up by one piece is a shortfall invented by arithmetic. 199.9
// pieces is a target of 199.
//
// ── AND MISSING IS NEVER ZERO ───────────────────────────────────────────────
// Anything that cannot be computed comes back `null`, with a reason. A SAM of
// zero would make every division infinite, and reporting the target as 0 would
// read as "this line makes nothing" rather than "nobody has approved a standard
// time yet". Both are caught here and reported as unavailable.
"use strict";

/* Minutes are held as integer ten-thousandths, so 0.1 + 0.2 is exact. */
const SCALE = 10000;

/** Minutes → integer ten-thousandths. The one place a minute becomes units. */
const toUnits = (minutes) => Math.round(Number(minutes) * SCALE);

/** The single documented rounding policy: half-up to four decimal places. */
const round4 = (n) => Math.round(n * 10000) / 10000;
const unitsToMinutes = (units) => round4(units / SCALE);

/** Why a figure could not be computed. Never a zero standing in for a fact. */
const UNAVAILABLE = Object.freeze({
  NO_SAM: "NO_GARMENT_SAM",
  NO_OPERATORS: "NO_PLANNED_OPERATORS",
  NO_NET_TIME: "NO_NET_PRODUCTIVE_TIME",
  NO_EFFICIENCY: "NO_TARGET_EFFICIENCY",
});

const finite = (n) => Number.isFinite(Number(n));

/**
 * Calculate one capacity standard's output.
 *
 * @param {object} input
 * @param {number} input.availableShiftMinutes  gross length of one shift
 * @param {number} input.breakMinutes           non-productive minutes in it
 * @param {number} input.shiftsPerDay
 * @param {number} input.plannedOperatorCount   the ONLY manpower the formula uses
 * @param {number} input.targetEfficiencyPercent  > 0 and <= 100
 * @param {number} input.garmentSamMinutes      server-derived, never a client's
 */
function calculateCapacity({
  availableShiftMinutes,
  breakMinutes = 0,
  shiftsPerDay = 1,
  plannedOperatorCount,
  targetEfficiencyPercent,
  garmentSamMinutes,
} = {}) {
  const grossUnits = finite(availableShiftMinutes) ? toUnits(availableShiftMinutes) : null;
  const breakUnits = finite(breakMinutes) ? toUnits(breakMinutes) : null;
  const samUnits = finite(garmentSamMinutes) ? toUnits(garmentSamMinutes) : null;
  const operators = finite(plannedOperatorCount) ? Number(plannedOperatorCount) : null;
  const shifts = finite(shiftsPerDay) ? Number(shiftsPerDay) : null;
  const percent = finite(targetEfficiencyPercent) ? Number(targetEfficiencyPercent) : null;

  /* Net productive minutes: exact integer subtraction, and never negative —
     breaks longer than the shift are a contradiction the validator refuses
     before this is called, and a clamp here would hide it if it ever were not. */
  const netUnits = grossUnits === null || breakUnits === null ? null : grossUnits - breakUnits;

  const operatorUnits = netUnits === null || operators === null || netUnits < 0
    ? null
    : netUnits * operators;

  /* WHY the figures below cannot be produced — collected before any division,
     so nothing divides by zero and nothing reports a false nought. */
  const reasons = [];
  if (samUnits === null || samUnits <= 0) reasons.push(UNAVAILABLE.NO_SAM);
  if (operators === null || operators <= 0) reasons.push(UNAVAILABLE.NO_OPERATORS);
  if (netUnits === null || netUnits <= 0) reasons.push(UNAVAILABLE.NO_NET_TIME);
  if (percent === null || percent <= 0) reasons.push(UNAVAILABLE.NO_EFFICIENCY);

  const base = {
    netMinutesPerShift: netUnits === null ? null : unitsToMinutes(netUnits),
    availableOperatorMinutesPerShift: operatorUnits === null ? null : unitsToMinutes(operatorUnits),
    garmentSamMinutes: samUnits === null ? null : unitsToMinutes(samUnits),
    targetEfficiencyPercent: percent === null ? null : round4(percent),
    shiftsPerDay: shifts,
    available: false,
    unavailableReasons: reasons,
    /* Named in the payload rather than left to a reader to assume. */
    rounding: "HALF_UP_4DP",
    wholePiecePolicy: "FLOOR",
  };

  if (reasons.length) {
    return {
      ...base,
      targetPiecesPerHour: null,
      theoreticalPiecesPerShift: null,
      wholePieceShiftTarget: null,
      theoreticalPiecesPerDay: null,
      wholePieceDailyTarget: null,
    };
  }

  /* ── ONE DIVISION EACH, FROM EXACT INTEGERS ────────────────────────────
     Each figure is built as an exact integer numerator over an exact integer
     denominator and divided ONCE. In particular the daily figure is NOT the
     shift figure multiplied by the shift count: a per-shift result that does
     not terminate in binary — 586.66… pieces, say — comes back a hair BELOW
     its true value, and multiplying that by three then flooring loses two whole
     pieces a day to arithmetic nobody chose. Dividing the day's own numerator
     once gives 1760, which is the answer.

     The `percent` stays a percentage right up to the denominator's `× 100`, so
     no ratio is ever materialised and no reader has to know which unit is in
     play. Every numerator here stays far inside exact-integer range: the
     largest possible is a 1440-minute shift, 5000 operators, three shifts and
     100% — about 2.2e13, against a 9.0e15 ceiling. */
  const denominator = samUnits * 100;
  const piecesPerHour = (operators * 60 * percent * SCALE) / denominator;
  const piecesPerShift = (operatorUnits * percent) / denominator;
  const piecesPerDay = (operatorUnits * shifts * percent) / denominator;

  return {
    ...base,
    available: true,
    unavailableReasons: [],
    /* Decimal truth, rounded once by the stated policy… */
    targetPiecesPerHour: round4(piecesPerHour),
    theoreticalPiecesPerShift: round4(piecesPerShift),
    theoreticalPiecesPerDay: round4(piecesPerDay),
    /* …and the conservative commitment, floored from the UNROUNDED figure so a
       value that rounds up to the next piece cannot become a target. */
    wholePieceShiftTarget: Math.floor(piecesPerShift),
    wholePieceDailyTarget: Math.floor(piecesPerDay),
  };
}

/**
 * The garment SAM for a layout, from its OWN frozen rows.
 *
 * Summed in integer units over every captured source row — the whole garment,
 * not only the operations somebody has placed at a station yet, because the SAM
 * of a garment does not depend on how far the line planner has got. A layout
 * with no rows has no SAM, and says so with zero rows rather than 0.0 minutes.
 */
function garmentSamFor(sourceRows = []) {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const units = rows.reduce(
    (sum, r) => sum + (finite(r?.standardTimeMinutes) ? toUnits(r.standardTimeMinutes) : 0),
    0,
  );
  return {
    garmentSamMinutes: unitsToMinutes(units),
    samRowCount: rows.length,
    samDerivation: "SUM_OF_FROZEN_LAYOUT_SOURCE_ROW_APPROVED_STANDARD_TIMES",
  };
}

module.exports = {
  SCALE, UNAVAILABLE,
  toUnits, round4, unitsToMinutes,
  calculateCapacity, garmentSamFor,
};
