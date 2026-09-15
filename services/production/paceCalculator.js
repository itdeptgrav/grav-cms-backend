// services/production/paceCalculator.js
//
// PACE AGAINST STANDARD TIME, FROM SCAN-TO-SCAN INTERVALS.
//
//     intervals        = valid consecutive pairs
//     totalSamSeconds  = SAM x intervals
//     totalActual      = sum of those intervals
//     pacePercent      = totalSamSeconds / totalActual x 100
//
// Equivalently SAM / average interval x 100. Note the two are only the same
// because the ratio is taken ONCE over the totals — averaging the per-interval
// percentages would give a different and wrong answer, which is the single most
// important rule in this file.
//
// ── WHY THIS IS CALLED PACE, NOT EFFICIENCY ──────────────────────────────────
// It answers "when they were working, how fast were they going", which is
// `performance` in industrial-engineering terms. The existing
// OperatorDayStats.overallEfficiencyPercent answers a different question — how
// much of the attended day produced value (earned minutes over attendance less
// breaks) — and that remains the efficiency figure. Both are kept because
// neither substitutes for the other: an operator can work quickly for two hours
// of an eight-hour shift and be 100% on one and 25% on the other.
//
// ── WHAT IS EXCLUDED FROM THE DENOMINATOR, AND WHY ───────────────────────────
// Measured on real data, a single 161-minute machine stop was 40% of one day's
// total interval time, and gaps over 30 minutes were 72% of it. Left in, the
// figure moves with breakdowns rather than with how fast anyone sews — the
// opposite of what it is for. So an interval is dropped when it is longer than
// the idle threshold, or when a recorded break falls inside it. Every drop is
// COUNTED AND REPORTED: the caller can always see how much of the elapsed time
// was set aside, and an interval that was excluded contributes no SAM either,
// so numerator and denominator stay honest with each other.
//
// ── REPEAT SCANS ARE NOT INTERVALS ───────────────────────────────────────────
// The same garment read twice produces no garment the second time. Counting it
// would add a whole SAM of earned time for the seconds between the two reads —
// a scanner double-firing four seconds apart would look like exceptional speed.
// So repeats are removed before intervals are formed.

"use strict";

/* NO IDLE THRESHOLD BY DEFAULT — every gap is counted.
 *
 * Until 2026-09-15 this was 180 seconds: a gap longer than three minutes was
 * assumed to be a machine stop and thrown away. That was a GUESS about what
 * happened in the gap, and it guessed wrong in both directions — it discarded
 * genuinely slow work (an operation whose standard time exceeds 180s could
 * never be measured at all), while leaving only the seconds-apart readings of
 * batch scanning, which pushed the figure far above 100%.
 *
 * Counting every gap is the opposite trade and the system owner chose it
 * knowingly: elapsed time now includes waiting, no-work-available, thread
 * breaks and lunch, all of it attributed to the garment that follows. On real
 * data (2026-09-12, one machine) the day moves from 1177.4% to 11.7% — and
 * 11.7% is a true statement of a DIFFERENT thing: 49 minutes of standard work
 * emerged from 6h 41m of elapsed time. It is not how fast anybody sews.
 *
 * Set IDLE_GAP_SEC to restore a threshold (IDLE_GAP_SEC=180 is the old
 * behaviour); callers may still pass opts.idleGapSec per call.
 */
const DEFAULT_IDLE_GAP_SEC = Number(process.env.IDLE_GAP_SEC) || Infinity;

/** The garment identity shared with the rest of the system. */
function pieceKeyOf(scan) {
  return `${scan.barcodeId}|${[...(scan.activeOps || [])].sort().join(",")}`;
}

/**
 * @param {Array}  scans  events with scanTime; order does not matter
 * @param {number} samSeconds  the standard time for ONE piece of this operation
 * @param {object} [opts]
 *   idleGapSec      gaps longer than this are stops, not work (default 180)
 *   excludeRepeats  drop re-reads of a garment already counted (default true)
 *   breaks          [{start,end}] recorded breaks; an interval containing one
 *                   is excluded, because the operator was not at the machine
 *   detail          keep the per-interval rows for a detailed report
 * @returns {object} never throws; `measurable` says whether there is an answer
 */
function calculatePace(scans, samSeconds, opts = {}) {
  const idleGapSec = opts.idleGapSec == null ? DEFAULT_IDLE_GAP_SEC : opts.idleGapSec;
  const excludeRepeats = opts.excludeRepeats !== false;
  const breaks = opts.breaks || [];

  const out = {
    samSeconds: Number.isFinite(samSeconds) && samSeconds > 0 ? samSeconds : null,
    scansConsidered: 0,
    intervals: 0,
    totalSamSeconds: 0,
    totalActualSeconds: 0,
    averageActualSeconds: null,
    pacePercent: null,
    measurable: false,
    reason: null,
    excluded: { invalidTime: 0, repeats: 0, longGaps: 0, breaks: 0, nonPositive: 0 },
    excludedSeconds: 0,
    /* Always collected: the batch-scanning guard below reads them. Dropped
       before returning unless the caller asked for the detail. */
    rows: [],
  };

  if (!Array.isArray(scans) || scans.length === 0) {
    out.reason = "no scans in this period";
    if (!opts.detail) delete out.rows;
    return out;
  }
  if (!out.samSeconds) {
    out.reason = "no standard time set for this operation";
    if (!opts.detail) delete out.rows;
    return out;
  }

  /* 1 ── Usable scans only. A scan with no readable timestamp cannot sit in a
         sequence; it is dropped and counted rather than silently coerced to an
         epoch date, which would manufacture an enormous interval. */
  const usable = [];
  for (const s of scans) {
    const t = s.scanTime instanceof Date ? s.scanTime.getTime() : new Date(s.scanTime).getTime();
    if (!Number.isFinite(t)) {
      out.excluded.invalidTime += 1;
      continue;
    }
    usable.push({ t, scan: s });
  }

  /* 2 ── Chronological. Devices upload in batches and a queue flushed after a
         reconnect can arrive out of order; unsorted input would produce
         negative intervals and a nonsense total. */
  usable.sort((a, b) => a.t - b.t);

  /* 3 ── One entry per garment. Order matters here: dedupe BEFORE forming
         intervals, so a repeat neither adds an interval nor splits a real one. */
  const kept = [];
  const seen = new Set();
  for (const u of usable) {
    if (excludeRepeats && u.scan.barcodeId) {
      const k = pieceKeyOf(u.scan);
      if (seen.has(k)) {
        out.excluded.repeats += 1;
        continue;
      }
      seen.add(k);
    }
    kept.push(u);
  }

  out.scansConsidered = kept.length;
  if (kept.length < 2) {
    out.reason =
      kept.length === 1
        ? "only one garment — an interval needs two scans"
        : "no garments to measure";
    if (!opts.detail) delete out.rows;
    return out;
  }

  const breakRanges = breaks
    .map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end ?? b.start).getTime(),
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));

  /* 4 ── The intervals. N kept garments give N-1 pairs; the first is a
         reference only and contributes nothing, which is why SAM is multiplied
         by the INTERVAL count and never by the scan count. */
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const cur = kept[i];
    const seconds = (cur.t - prev.t) / 1000;

    let excluded = null;
    if (!(seconds > 0)) {
      // Two reads on the same second. Dividing by it would be infinite.
      out.excluded.nonPositive += 1;
      excluded = "duplicate timestamp";
    } else if (seconds > idleGapSec) {
      out.excluded.longGaps += 1;
      out.excludedSeconds += seconds;
      excluded = "stop";
    } else if (breakRanges.some((b) => b.start < cur.t && b.end > prev.t)) {
      out.excluded.breaks += 1;
      out.excludedSeconds += seconds;
      excluded = "break";
    }

    if (!excluded) {
      out.intervals += 1;
      out.totalActualSeconds += seconds;
    }

    if (out.rows) {
      out.rows.push({
        index: i + 1,
        at: cur.scan.scanTime,
        previousAt: prev.scan.scanTime,
        barcodeId: cur.scan.barcodeId || "",
        intervalSeconds: seconds > 0 ? seconds : 0,
        counted: !excluded,
        excludedBecause: excluded,
      });
    }
  }

  if (out.intervals === 0) {
    out.reason =
      out.excluded.longGaps > 0
        ? "every gap was longer than a working interval — nothing to measure pace against"
        : "no usable intervals";
    if (!opts.detail) delete out.rows;
    return out;
  }

  /* ── IS THIS FLOOR SCANNING PER GARMENT? ──────────────────────────────────
     Pace only means anything if each scan marks a garment being finished. On
     real data this floor scans in BURSTS — measured: five bursts of two or
     three scans four to ten seconds apart, separated by gaps of ten minutes to
     2.7 hours. Somebody is carrying a handful of finished garments over and
     scanning them together.

     Those four-second intervals are not cycle times; they are how fast a person
     can wave three tickets at a reader. Against a 131-second SAM they produce
     988%, which is not a fast operator — it is a measurement of the wrong
     thing. Reporting it as pace would repeat exactly the mistake that made the
     old efficiency read 989%.

     So an interval far below the standard time is counted as evidence of batch
     scanning, and when most of them are, the figure is returned with
     `batchScanning: true` and the reason attached. The number is still there —
     it is not the calculator's place to hide data — but nothing downstream can
     present it as a confident pace without also saying this. */
  /* MEASURED OVER EVERY ADJACENT PAIR, NOT ONLY THE COUNTED ONES.
     This diagnostic must not move when the idle-gap POLICY moves. Judged
     against counted intervals alone it would silently switch itself off the
     moment the threshold was lifted: on 2026-09-12 the same six burst readings
     are 6 of 8 counted intervals (75%, flagged) under a 180s threshold but
     6 of 18 (33%) once every gap is counted. The batch scanning did not stop
     happening — only the denominator changed. So the fraction is taken over
     all adjacent garment pairs, which is a property of how the floor scans and
     of nothing else. */
  const BATCH_FRACTION = 0.25; // an interval under a quarter of SAM is implausible
  const BATCH_SHARE = 0.25;    // ...and this share of all pairs being so is the signature
  const allPairs = (out.rows || []).length;
  const implausiblyShort = (out.rows || [])
    .filter((r) => r.intervalSeconds > 0 && r.intervalSeconds < out.samSeconds * BATCH_FRACTION).length;
  if (out.rows) {
    out.batchScanCandidates = implausiblyShort;
    out.batchScanning = allPairs > 0 && implausiblyShort / allPairs >= BATCH_SHARE;
    if (out.batchScanning) {
      out.caveat =
        `${implausiblyShort} of ${allPairs} gaps between garments are shorter than a quarter ` +
        `of the standard time, which is the signature of garments being scanned in batches ` +
        `rather than as each one is finished. This figure therefore reflects when tickets ` +
        `were presented, not how long the work took.`;
    }
  }

  /* WHAT THE ELAPSED TIME NOW CONTAINS. With no idle threshold the denominator
     is wall-clock time between garments: waiting for work, thread breaks and
     unrecorded absence are all inside it. The figure is honest about output per
     hour present; it is NOT a measure of working speed, and every surface that
     prints it says so. */
  if (!Number.isFinite(idleGapSec)) {
    out.includesIdleTime = true;
    out.basis =
      "elapsed time between garments, including any waiting — output per hour present, not working speed";
  }

  out.totalSamSeconds = out.samSeconds * out.intervals;
  out.averageActualSeconds = out.totalActualSeconds / out.intervals;
  /* The ratio of TOTALS, taken once. Not the mean of per-interval percentages —
     those are different numbers, and the second one is wrong. */
  out.pacePercent =
    Math.round((out.totalSamSeconds / out.totalActualSeconds) * 1000) / 10;
  out.measurable = true;
  if (!opts.detail) delete out.rows;
  return out;
}

/**
 * Pace per operation code across a set of scans.
 *
 * A machine may run two operations at once, and one scan then completes both —
 * so the same scan legitimately appears in both operations' sequences, each
 * measured against its own SAM. The intervals are identical in that case and
 * only the standard time differs, which is the honest reading: the cadence is
 * the machine's, the standard is the operation's.
 *
 * @param {Map|object} samByCode  operation code -> SAM in seconds
 */
function paceByOperation(scans, samByCode, opts = {}) {
  const get = (code) =>
    samByCode instanceof Map ? samByCode.get(code) : samByCode[code];
  const codes = new Set();
  for (const s of scans) for (const c of s.activeOps || []) codes.add(String(c).trim());

  const out = [];
  for (const code of [...codes].sort()) {
    const mine = scans.filter((s) => (s.activeOps || []).some((c) => String(c).trim() === code));
    out.push({ operationCode: code, ...calculatePace(mine, get(code), opts) });
  }
  return out;
}

/** The same, grouped by whatever key names a person, machine or table. */
function paceByGroup(scans, keyOf, samByCode, opts = {}) {
  const groups = new Map();
  for (const s of scans) {
    const k = keyOf(s);
    if (k == null || k === "") continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const [key, list] of groups) {
    out.push({ key, operations: paceByOperation(list, samByCode, opts) });
  }
  return out;
}

module.exports = {
  calculatePace,
  paceByOperation,
  paceByGroup,
  pieceKeyOf,
  DEFAULT_IDLE_GAP_SEC,
};
