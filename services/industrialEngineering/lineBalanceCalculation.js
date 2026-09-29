// services/industrialEngineering/lineBalanceCalculation.js
//
// LINE BALANCE — THE WHOLE ARITHMETIC, AND NOTHING ELSE.
//
// Pure, like its Chunk 4A/4B neighbours: no database, no request, no clock. It
// takes stations holding minutes and returns the six figures an industrial
// engineer balances a line on, so the numbers a person checks against a sheet
// of paper live where they can be read on their own.
//
// ── THE FORMULAS, WRITTEN ONCE ──────────────────────────────────────────────
//   totalWorkContentMinutes  = Σ assigned standard times
//   stationWorkloadMinutes   = Σ assigned standard times of that station
//   stationCount             = stations stored, an intentionally empty one
//                              included — an empty station is a decision about
//                              the line, and leaving it out of the divisor
//                              would flatter the efficiency of a line that has
//                              somebody standing idle in it
//   pitchMinutes             = totalWorkContent ÷ stationCount
//   bottleneckMinutes        = max(stationWorkload)
//   balanceEfficiencyPercent = totalWorkContent ÷ (stationCount × bottleneck) × 100
//   balanceLossPercent       = 100 − balanceEfficiency
//
// ── DECIMAL-SAFE, BECAUSE MINUTES DO NOT ADD UP IN BINARY ───────────────────
// 0.1 + 0.2 is not 0.3 in a double, and a line has hundreds of these additions.
// Every standard time is therefore converted once to an integer number of
// ten-thousandths of a minute — the precision Chunk 4B stores and publishes —
// summed as integers, and converted back only when a figure is returned. Two
// stations holding the same operations in a different order produce the same
// total, which is the property a balance depends on.
//
// ── AND A ZERO DENOMINATOR IS NOT A ZERO PERCENT ────────────────────────────
// No stations, or stations with no work in them, means there is no efficiency —
// not an efficiency of zero. `NaN`, `Infinity` and a misleading 0% are all
// worse than `null`, because each of them renders as a number somebody can act
// on. The caller gets nulls and a reason.
"use strict";

/** Ten-thousandths of a minute: the precision an approved standard time holds. */
const SCALE = 10000;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** Minutes → integer ten-thousandths, rounded half-up once. */
const toUnits = (minutes) => Math.round(minutes * SCALE);

/**
 * THE ONE ROUNDING POLICY: half-up to four decimal places, applied once, at the
 * response boundary and nowhere else. Stored values keep their full precision
 * so a recalculation can never disagree with a stored one.
 */
const round4 = (n) => Math.round(n * 10000) / 10000;
const unitsToMinutes = (units) => round4(units / SCALE);

/**
 * @param {Array} stations  [{ stationId, assignments: [{ standardTimeMinutes }] }]
 * @returns metrics with nulls where a figure does not exist
 */
function calculateLineBalance(stations = []) {
  const rows = Array.isArray(stations) ? stations : [];

  const perStation = rows.map((station) => {
    const assignments = Array.isArray(station?.assignments) ? station.assignments : [];
    const units = assignments.reduce(
      (sum, a) => sum + (isFiniteNumber(a?.standardTimeMinutes) ? toUnits(a.standardTimeMinutes) : 0),
      0,
    );
    return { stationId: station?.stationId ?? null, units, assignmentCount: assignments.length };
  });

  const stationCount = perStation.length;
  const totalUnits = perStation.reduce((sum, s) => sum + s.units, 0);
  const bottleneckUnits = perStation.reduce((max, s) => (s.units > max ? s.units : max), 0);

  /* Both denominators, stated separately, because they fail for different
     reasons and a caller may need to say which. */
  const hasStations = stationCount > 0;
  const hasWork = bottleneckUnits > 0;

  const efficiency = hasStations && hasWork
    ? round4((totalUnits / (stationCount * bottleneckUnits)) * 100)
    : null;

  return {
    totalWorkContentMinutes: hasStations || totalUnits ? unitsToMinutes(totalUnits) : 0,
    stationCount,
    pitchMinutes: hasStations ? unitsToMinutes(totalUnits / stationCount) : null,
    bottleneckMinutes: hasStations ? unitsToMinutes(bottleneckUnits) : null,
    balanceEfficiencyPercent: efficiency,
    /* Derived from the ROUNDED efficiency, so the two published percentages
       always add to 100 rather than to 99.9999. */
    balanceLossPercent: efficiency === null ? null : round4(100 - efficiency),
    /* Says WHY a figure is missing, so a screen shows a reason instead of a
       dash it has to explain itself. */
    metricsAvailable: Boolean(hasStations && hasWork),
    metricsUnavailableReason: hasStations
      ? (hasWork ? null : "NO_WORK_ASSIGNED")
      : "NO_STATIONS",
    stationWorkloads: perStation.map((s) => ({
      stationId: s.stationId,
      workloadMinutes: unitsToMinutes(s.units),
      assignmentCount: s.assignmentCount,
      /* How far this station is from the bottleneck — the number a person
         moves work by. Null while there is no bottleneck to be idle against. */
      idleMinutes: hasWork ? unitsToMinutes(bottleneckUnits - s.units) : null,
      isBottleneck: hasWork && s.units === bottleneckUnits,
    })),
  };
}

module.exports = { calculateLineBalance, round4, toUnits, SCALE };
