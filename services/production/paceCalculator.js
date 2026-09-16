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
 *   boundaries      [{start,end,kind}] spans when the operator was NOT at the
 *                   machine — a recorded break, or the time between a signout
 *                   and the next signin. An interval containing one is excluded
 *                   and the scan after it becomes a new start point, because a
 *                   garment cannot be timed across a gap the operator was away
 *                   for. `breaks` is still accepted as the old name.
 *   anchors         [{at,kind}] moments the operator RESUMED work — a signin,
 *                   or a break_end. The garment scanned after one is timed FROM
 *                   it: the ID card is when work started, so the first garment
 *                   of a session is real work, not an unmeasurable reference.
 *   detail          keep the per-interval rows for a detailed report
 * @returns {object} never throws; `measurable` says whether there is an answer
 */
function calculatePace(scans, samSeconds, opts = {}) {
  const idleGapSec = opts.idleGapSec == null ? DEFAULT_IDLE_GAP_SEC : opts.idleGapSec;
  const excludeRepeats = opts.excludeRepeats !== false;
  /* Accepts the old `breaks` name so existing callers keep working. */
  const boundaryInput = opts.boundaries || opts.breaks || [];

  /* Sorted once: `resumeBefore` walks these per garment, and an unsorted list
     would pick an earlier resume when a later one opened the session. */
  const anchors = (opts.anchors || [])
    .map((a) => ({ t: new Date(a.at).getTime(), kind: a.kind || "sign-in" }))
    .filter((a) => Number.isFinite(a.t))
    .sort((x, y) => x.t - y.t);

  /* The away span that ENDS at a resume — the sign-out this sign-in closed, or
     the break this break_end closed. Attached to the resume rather than to the
     garment: it describes what happened BEFORE the session, so hanging it on the
     first garment made a two-hour-old absence look like part of a one-minute
     interval. */
  const awayEndingAt = (t) =>
    boundaryRanges.find((b) => Math.abs(b.end - t) < 1000) || null;

  /* The latest resume between the previous garment and this one. `prevT` null
     means this is the day's first garment, so any resume before it qualifies. */
  const resumeBefore = (t, prevT) => {
    let best = null;
    for (const a of anchors) {
      if (a.t >= t) break;
      if (prevT != null && a.t <= prevT) continue;
      best = a;
    }
    return best;
  };
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
  /* One garment is measurable when a sign-in preceded it — there is a clock to
     start from. Only a garment with nothing before it has nothing to say. */
  const anchorBeforeFirst =
    kept.length > 0 && anchors.some((a) => a.t < kept[0].t);
  if (kept.length === 0 || (kept.length < 2 && !anchorBeforeFirst)) {
    out.reason =
      kept.length === 1
        ? "only one garment, and no sign-in before it to measure from"
        : "no garments to measure";
    if (!opts.detail) delete out.rows;
    return out;
  }

  const boundaryRanges = boundaryInput
    .map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end ?? b.start).getTime(),
      kind: b.kind || "break",
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));

  /* 4 ── The intervals. N kept garments give N-1 pairs; the first is a
         reference only and contributes nothing, which is why SAM is multiplied
         by the INTERVAL count and never by the scan count. */
  for (let i = 0; i < kept.length; i++) {
    const prev = i > 0 ? kept[i - 1] : null;
    const cur = kept[i];

    /* WHERE THIS GARMENT'S CLOCK STARTS — the previous garment normally, but
       the resume if the operator came back in between. They were not at the
       machine before that, so timing from the previous garment would charge
       them for the absence, and discarding the garment threw away real work. */
    const resume = resumeBefore(cur.t, prev ? prev.t : null);
    const fromT = resume ? resume.t : prev ? prev.t : null;

    if (fromT == null) {
      /* Nothing before it at all: no previous garment and no sign-in. */
      if (out.rows) {
        out.rows.push({
          index: i + 1,
          at: cur.scan.scanTime,
          previousAt: null,
          barcodeId: cur.scan.barcodeId || "",
          intervalSeconds: 0,
          counted: false,
          excludedBecause: "no start point",
          reference: true,
          anchoredTo: null,
          boundary: null,
        });
      }
      continue;
    }

    const seconds = (cur.t - fromT) / 1000;

    let excluded = null;
    if (!(seconds > 0)) {
      // Two reads on the same second. Dividing by it would be infinite.
      out.excluded.nonPositive += 1;
      excluded = "duplicate timestamp";
    } else if (seconds > idleGapSec) {
      out.excluded.longGaps += 1;
      out.excludedSeconds += seconds;
      excluded = "stop";
    }
    /* The operator was away inside this gap — a break card or a sign-out. The
       garment was not being worked on for part of it, so the pair cannot be a
       cycle time. The row still goes out: the screen shows the away span and
       treats the scan after it as a fresh start point, the same as the first
       scan of the shift. */
    /* The away span must overlap the window ACTUALLY BEING MEASURED, fromT to
       cur.t — not merely start before this garment.
       
       The first version tested `b.end > (prev ? prev.t : b.start - 1)`, and with
       no previous garment that second branch reduces to `b.end > b.start - 1`,
       which is true of every span there has ever been. So the first garment of a
       session matched the day's earliest sign-out and the log showed
       "11:39:30 → 11:43:06" against a garment scanned at 13:05 — an absence from
       two hours earlier reported as part of a one-minute interval.
       
       Anchoring to a sign-in makes the away span end exactly at fromT, so it
       correctly falls outside the window: the "Signed in — start point" row
       above already says the session restarted. What still matches is a break or
       sign-out with no resume after it, which is the case that must be
       excluded. */
    const boundary =
      boundaryRanges.find((b) => b.start < cur.t && b.end > fromT) || null;
    if (!excluded && boundary && !resume) {
      out.excluded.breaks += 1;
      out.excludedSeconds += seconds;
      excluded = boundary.kind;
    }

    if (!excluded) {
      out.intervals += 1;
      out.totalActualSeconds += seconds;
    }

    if (out.rows) {
      out.rows.push({
        index: i + 1,
        at: cur.scan.scanTime,
        previousAt: resume ? new Date(resume.t).toISOString() : prev.scan.scanTime,
        /* Lets the log draw the sign-in as its own start-point row and say
           "from sign-in" on the garment that follows it. */
        anchoredTo: resume
          ? (() => {
              const away = awayEndingAt(resume.t);
              return {
                kind: resume.kind,
                at: new Date(resume.t).toISOString(),
                /* What the operator was doing until this moment, so the log can
                   show "signed out 216s" on its own line above the sign-in. */
                after: away
                  ? {
                      kind: away.kind,
                      start: new Date(away.start).toISOString(),
                      end: new Date(away.end).toISOString(),
                      seconds: Math.round((away.end - away.start) / 1000),
                    }
                  : null,
              };
            })()
          : null,
        barcodeId: cur.scan.barcodeId || "",
        intervalSeconds: seconds > 0 ? seconds : 0,
        counted: !excluded,
        excludedBecause: excluded,
        /* What the operator was doing instead, and for how long, so the log can
           say "signed out 216s" rather than leaving a hole in the sequence. */
        boundary: boundary
          ? {
              kind: boundary.kind,
              start: new Date(boundary.start).toISOString(),
              end: new Date(boundary.end).toISOString(),
              seconds: Math.round((boundary.end - boundary.start) / 1000),
            }
          : null,
      });
    }
  }

  /* Did the operator leave after the last garment? A sign-out with no sign-in
     after it closes the sequence, and nothing reported it: the log simply
     stopped at the final garment, so a shift that ended looked identical to one
     still running. */
  if (kept.length) {
    const lastT = kept[kept.length - 1].t;
    const closing = boundaryRanges.find((b) => b.start >= lastT);
    if (closing) {
      /* How long the session ran: the sign-in that opened it to the sign-out
         that closed it. That is the number worth reading on a closing row —
         "this stint lasted 4m12s" — not how long they were away beforehand. */
      const opened = anchors.filter((a) => a.t <= closing.start).pop() || null;
      out.closedBy = {
        kind: closing.kind,
        at: new Date(closing.start).toISOString(),
        sessionFrom: opened ? new Date(opened.t).toISOString() : null,
        sessionSeconds: opened ? Math.round((closing.start - opened.t) / 1000) : null,
      };
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
      /* Plain words on purpose: this is read by supervisors on the floor, not by
         industrial engineers, and a warning nobody understands is not a warning. */
      out.caveat =
        `${implausiblyShort} of ${allPairs} gaps are shorter than a quarter of the SAM time. ` +
        `That means garments were scanned in batches, not one by one as each was finished. ` +
        `So this figure shows when the tickets were scanned, not how long the work took.`;
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
      "Time between garments, including any waiting. This is work done per hour on the floor, not how fast the operator sews.";
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
/**
 * ONE FIGURE FROM A SET OF PER-OPERATION RESULTS.
 *
 * A garment-interval contributes its elapsed seconds ONCE and earns the SAM of
 * every operation that interval completed. A machine can run two operations at
 * once, and then one scan closes both: summing the operations naively would add
 * the same seconds to the denominator twice while adding each standard once,
 * which is neither operation's figure nor a blend of them.
 *
 * Requires ops built with `detail: true` — the dedupe key comes from `rows`.
 *
 * @returns {{totalSamSeconds:number,totalActualSeconds:number,intervals:number,pacePercent:number|null}}
 */
function rollupPace(ops) {
  const byInterval = new Map(); // prevAt|at|barcode -> {seconds, sam}
  for (const o of ops || []) {
    if (!(o.samSeconds > 0)) continue;
    for (const row of o.rows || []) {
      if (!row.counted) continue;
      const k = `${new Date(row.previousAt).getTime()}|${new Date(row.at).getTime()}|${row.barcodeId}`;
      const cur = byInterval.get(k);
      if (cur) cur.sam += o.samSeconds;
      else byInterval.set(k, { seconds: row.intervalSeconds, sam: o.samSeconds });
    }
  }
  let sam = 0;
  let actual = 0;
  for (const v of byInterval.values()) {
    sam += v.sam;
    actual += v.seconds;
  }
  return {
    totalSamSeconds: sam,
    totalActualSeconds: actual,
    intervals: byInterval.size,
    pacePercent: actual > 0 ? Math.round((sam / actual) * 1000) / 10 : null,
  };
}

/**
 * Per-group pace, each group rolled up by the same rule as the floor figure.
 *
 * The rollup needs `rows`, so detail is forced on regardless of what the caller
 * asked for, and the rows are dropped again afterwards unless the caller wanted
 * them — a group's rows are per-operation detail that no caller of this has
 * ever used, and they dominate the response size.
 */
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
    const operations = paceByOperation(list, samByCode, { ...opts, detail: true });
    const totals = rollupPace(operations);
    if (!opts.detail) for (const o of operations) delete o.rows;
    out.push({ key, ...totals, operations });
  }
  return out;
}

module.exports = {
  calculatePace,
  paceByOperation,
  paceByGroup,
  rollupPace,
  pieceKeyOf,
  DEFAULT_IDLE_GAP_SEC,
};
