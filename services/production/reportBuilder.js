// services/production/reportBuilder.js
//
// ONE CALCULATION, EVERY FORMAT.
//
// The dashboard, the on-screen preview, the Excel workbook, the PDF and the CSV
// all answer the same question — "what happened over these dates" — and the one
// way to guarantee they agree is for there to be exactly one place that works it
// out. That is this file. Every export route is a renderer over `buildReport()`;
// none of them counts anything itself.
//
// This was previously inline in productionReportRoutes.js and served only the
// workbook. Moving it here changes no arithmetic: the functions below are the
// ones that produced the verified figures, lifted intact, with filtering and
// period totals added around them.
//
// ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────
// Nothing here invents production. Every figure is either counted from
// ProductionEvent with countDistinctPieces() — the one shared definition of a
// garment — or read from the rollup's own read models for the things scans
// cannot tell you (attendance, break, idle). There is no mock data in this file.
//
// ── A DAY WITH NO DATA IS A ROW, NOT A GAP ───────────────────────────────────
// A date nobody worked still appears, saying so. Omitting it silently would let
// a reader assume the export was truncated, and "the floor was shut" is a
// finding in its own right.

"use strict";

const B = "../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const MachineDayStats = require(`${B}/MachineDayStats`);
const OperatorDayStats = require(`${B}/OperatorDayStats`);

const S = "../barcodeScanner";
const { shiftDateFor, currentShiftDate } = require(`${S}/shift`);
const masterData = require(`${S}/masterData`);
const { countDistinctPieces, pieceKeyOf } = require(`${S}/rollupStats`);
/* Pace against standard time, from scan-to-scan intervals. A separate question
   from the rollup's efficiency (earned minutes over attended time) and kept as a
   separate number — see paceCalculator's header for why neither substitutes for
   the other. */
const { calculatePace, paceByOperation, paceByGroup } = require("./paceCalculator");

/** Widest range a single request may ask for. */
const MAX_DAYS = 92;

const IST_OFFSET_MIN = 330;

const round1 = (n) => Math.round(n * 10) / 10;

/** "YYYY-MM-DD" for a shiftDate, read in IST so it names the day the floor did. */
function dayKeyOf(shiftDate) {
  return new Date(new Date(shiftDate).getTime() + IST_OFFSET_MIN * 60000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Every shift date from `from` to `to` inclusive.
 *
 * Built by stepping ONE CALENDAR DAY at a time in UTC and bucketing each through
 * shiftDateFor, rather than by adding 24h to a shift boundary — the two are the
 * same today and would diverge the day the shift offset ever changes.
 */
function shiftDatesBetween(from, to) {
  const out = [];
  const cur = new Date(Date.UTC(from.y, from.m - 1, from.d));
  const end = new Date(Date.UTC(to.y, to.m - 1, to.d));
  while (cur <= end && out.length <= MAX_DAYS) {
    // Midday UTC: far from either midnight, so the bucket is unambiguous.
    out.push(shiftDateFor(new Date(cur.getTime() + 12 * 3600 * 1000)));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Every shift date from `from` to `to` inclusive.
 *
 * Built by stepping ONE CALENDAR DAY at a time in UTC and bucketing each through
 * shiftDateFor, rather than by adding 24h to a shift boundary — the two are the
 * same today and would diverge the day the shift offset ever changes.
 */
function shiftDatesBetween(from, to) {
  const out = [];
  const cur = new Date(Date.UTC(from.y, from.m - 1, from.d));
  const end = new Date(Date.UTC(to.y, to.m - 1, to.d));
  while (cur <= end && out.length <= MAX_DAYS) {
    // Midday UTC: far from either midnight, so the bucket is unambiguous.
    out.push(shiftDateFor(new Date(cur.getTime() + 12 * 3600 * 1000)));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function parseDayKey(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/**
 * Everything the workbook needs for ONE shift date.
 *
 * Returns `hasData: false` for a day nobody worked — the caller still writes a
 * row for it, because an empty day is information.
 */
async function gatherDay(shiftDate, master, filters = {}) {
  /* TWO BUCKETING CONVENTIONS EXIST IN THIS DATABASE, so matching shiftDate
     exactly finds only one of them:

       August events   2026-08-29T00:00:00Z  — midnight UTC
       current events  2026-09-11T18:30:00Z  — midnight IST

     shiftDateFor() produces the IST form, so an exact match made every August
     shift invisible and the report showed "No data available" for days that
     plainly had production. A half-open range from this shift's IST midnight to
     the next covers both spellings of the same day and cannot reach into the
     neighbouring one: the old form for a day always lands inside its own IST
     window. Whichever convention a row was written with, it is found. */
  const spanStart = new Date(shiftDate);
  const spanEnd = new Date(new Date(shiftDate).getTime() + 24 * 3600 * 1000);
  const inDay = { $gte: spanStart, $lt: spanEnd };

  const [events, machineStats, operatorStats] = await Promise.all([
    ProductionEvent.find({ shiftDate: inDay }).sort({ scanTime: 1 }).lean(),
    MachineDayStats.find({ shiftDate: inDay }).lean(),
    OperatorDayStats.find({ shiftDate: inDay }).lean(),
  ]);

  const scans = events.filter((e) => e.type === "scan");
  const machineName = new Map(
    (master.machines || []).map((m) => [String(m._id), m.name || ""])
  );
  const machineType = new Map(
    (master.machines || []).map((m) => [String(m._id), m.type || ""])
  );
  const opName = new Map(
    (master.operations || []).map((o) => [String(o.operationCode).trim(), o.name || ""])
  );
  const woInfo = new Map(
    (master.workOrders || []).map((w) => [
      String(w.shortId || ""),
      {
        productName: w.stockItemName || "",
        productCode: w.stockItemReference || "",
        customerName: w.customerName || "",
        workOrderNumber: w.workOrderNumber || "",
      },
    ])
  );
  const employeeName = new Map();
  for (const e of master.operators || []) {
    const name = [e.firstName, e.lastName].filter(Boolean).join(" ").trim();
    if (e.identityId) employeeName.set(String(e.identityId), name);
    if (e.biometricId) employeeName.set(String(e.biometricId), name);
  }
  const nameFor = (id) => employeeName.get(String(id)) || "";

  /* Which reads were repeats, decided once here so the scan sheet can flag each
     row and the totals cannot disagree with it. */
  const seen = new Set();
  const scanRows = scans.map((e) => {
    const key = e.barcodeId ? pieceKeyOf(e) : null;
    const repeat = Boolean(key && seen.has(key));
    if (key) seen.add(key);
    const wo = woInfo.get(String(e.workOrderKey || "")) || {};
    return {
      at: e.scanTime,
      barcodeId: e.barcodeId || "",
      unitNumber: e.unitNumber ?? "",
      machineId: String(e.machineId || ""),
      machineName: machineName.get(String(e.machineId)) || "Unknown machine",
      operatorId: e.operatorId || "",
      operatorName: e.operatorName || nameFor(e.operatorId),
      operations: (e.activeOps || []).join(", "),
      operationNames: (e.activeOps || [])
        .map((c) => opName.get(String(c).trim()) || String(c).trim())
        .join(", "),
      workOrder: e.workOrderKey || "",
      productName: wo.productName || "",
      productCode: wo.productCode || "",
      customerName: wo.customerName || "",
      countsAsProduction: repeat ? "No — repeat read" : "Yes",
      deviceId: e.deviceId || "",
      timeRecovered: e.timeRecovered ? "Yes" : "",
    };
  });

  const pieces = countDistinctPieces(scans);

  /* PACE BY OPERATION, from the same scans everything else on this day is built
     from — so a filtered report narrows the pace with it rather than leaving a
     figure behind that belongs to a wider set.

     Breaks come from the day's own break_start/break_end events, paired in
     order; an interval spanning one is set aside, because the operator was not
     at the machine. A break still open when the day ends closes at the last
     event, which is the most that can honestly be claimed for it. */
  /* DUPLICATE OPERATION CODES: KEEP THE FIRST, SKIP THE REPEAT.
     The same rule the scanner already applies to garments — a repeat is not a
     new thing, so it is dropped rather than allowed to replace what came
     before. This used to be `samByCode[code] = sec` in a loop, which is
     last-one-wins: S076 is present twice, at 32s and at 248s, and the later
     entry silently replaced the earlier one, making every S076 figure wrong by
     a factor of 7.75. Worse, WHICH value won depended on the order the master
     came back in, so it was not even reliably wrong.

     Skipping repeats makes it deterministic. It does not make it CORRECT —
     only the IE study knows whether S076 is 32s or 248s — so every conflict is
     recorded and surfaced on the report rather than resolved in silence. */
  const samByCode = {};
  const samConflicts = [];
  for (const o of master.operations || []) {
    const code = String(o.operationCode).trim();
    const sec = o.durationSeconds || (o.totalSam ? o.totalSam * 60 : 0);
    if (!(sec > 0)) continue;
    if (samByCode[code] == null) {
      samByCode[code] = sec;
    } else if (samByCode[code] !== sec) {
      samConflicts.push({ code, using: samByCode[code], ignored: sec });
    }
  }

  const breaks = [];
  let openBreak = null;
  for (const e of events) {
    if (e.type === "break_start") openBreak = e.scanTime;
    else if (e.type === "break_end" && openBreak) {
      breaks.push({ start: openBreak, end: e.scanTime });
      openBreak = null;
    }
  }
  if (openBreak && events.length) {
    breaks.push({ start: openBreak, end: events[events.length - 1].scanTime });
  }

  /* PACE IS MEASURED ON THE SCANS THE REPORT IS ABOUT, NOT THE WHOLE FLOOR.
     applyFilters() runs AFTER this function and rebuilds the totals, the rows
     and the operator and machine lists — but it cannot rebuild pace, because
     pace needs the scan events and it only has the flattened display rows. It
     therefore used to pass `pace` through untouched, so a report filtered to
     one person showed that person's garments beside the entire floor's
     efficiency. Measured: filtering to GR0108 (6 garments) and to GR0045 (15)
     both returned 19 garments and 11.7%, the unfiltered day.

     Narrowing here instead fixes it once for every surface — the on-screen
     block, the Excel sheet, the PDF section, the CSV header and the scan log
     all read this same object. */
  const paceScans = scans.filter((e) => {
    if (filters.operatorId && String(e.operatorId) !== String(filters.operatorId)) return false;
    if (filters.machineId && String(e.machineId) !== String(filters.machineId)) return false;
    if (filters.productName) {
      const wo = woInfo.get(String(e.workOrderKey || "")) || {};
      if ((wo.productName || "") !== filters.productName) return false;
    }
    return true;
  });

  const usedCodes = {};
  for (const e of paceScans) for (const c of e.activeOps || []) usedCodes[String(c).trim()] = true;

  const paceOps = paceByOperation(paceScans, samByCode, { breaks, detail: true });

  /* §9 — PER OPERATOR, PER OPERATION. "Employee A — Stitching — XX%".
     Each person's own scans form their own sequence: two operators on one
     machine interleave in the raw stream, and measuring that stream would give
     each of them the other's gaps. Splitting first is what makes the figure
     belong to the person. */
  const paceByOperator = paceByGroup(paceScans, (e) => e.operatorId, samByCode, { breaks });

  /* §10 already falls out of paceOps above (operation across all its scans),
     and the same grouping serves a machine or table. */
  const paceByMachine = paceByGroup(paceScans, (e) => String(e.machineId), samByCode, { breaks });
  /* One figure for the day: every operation's earned standard time over the
     time actually spent. A ratio of totals, never a mean of the per-operation
     percentages — the same rule that governs one operation's intervals governs
     the day's operations.

     WHY THE ELAPSED TIME IS DEDUPED AND THE STANDARD TIME IS NOT. A machine can
     run two operations at once, and then ONE scan completes both — so that one
     interval appears in both operations' sequences, correctly, each measured
     against its own SAM. Summing the operations naively would add the same
     seconds to the denominator twice while adding each standard once, giving a
     day figure that is neither operation's and not a blend of them either.
     Measured here: 8 intervals of 1:46 total across AP001 and AP002 summed to
     3:32 of "actual" time that nobody spent, and 588.7% — where the honest
     reading is that a garment clearing both operations earns 0:25 + 2:11 in
     that one interval.

     So: a garment-interval contributes its elapsed seconds ONCE, and earns the
     SAM of every operation it completed. */
  const earnedByInterval = new Map(); // prevAt|at|barcode -> {seconds, sam}
  for (const o of paceOps) {
    if (!(o.samSeconds > 0)) continue;
    for (const row of o.rows || []) {
      if (!row.counted) continue;
      const k = `${new Date(row.previousAt).getTime()}|${new Date(row.at).getTime()}|${row.barcodeId}`;
      const cur = earnedByInterval.get(k);
      if (cur) cur.sam += o.samSeconds;
      else earnedByInterval.set(k, { seconds: row.intervalSeconds, sam: o.samSeconds });
    }
  }
  let paceSam = 0;
  let paceActual = 0;
  for (const v of earnedByInterval.values()) {
    paceSam += v.sam;
    paceActual += v.seconds;
  }
  const paceIntervalCount = earnedByInterval.size;

  /* GARMENTS PER MACHINE AND PER OPERATOR, COUNTED HERE.
     The rollup's stored totalPieces is authoritative only for shifts it has
     recomputed since the scan-tally fix. August was written by the old code and
     still says 54 where the events say 26 — so reading it would have put two
     different answers in one workbook, the summary sheet disagreeing with the
     machine sheet about the same day. Counting from the events makes every
     sheet agree by construction, and needs no backfill of historical rollups.
     Time-based fields (attendance, break, idle) cannot be derived from scans
     and are still read from the rollup, which is their only source. */
  const machinePieces = new Map();
  const operatorPieces = new Map();
  for (const e of scans) {
    if (!e.barcodeId) continue;
    const mk = String(e.machineId);
    const ok = String(e.operatorId || "");
    if (!machinePieces.has(mk)) machinePieces.set(mk, new Set());
    machinePieces.get(mk).add(pieceKeyOf(e));
    if (ok) {
      if (!operatorPieces.has(ok)) operatorPieces.set(ok, new Set());
      operatorPieces.get(ok).add(pieceKeyOf(e));
    }
  }
  const machineScans = new Map();
  for (const e of scans) {
    const mk = String(e.machineId);
    machineScans.set(mk, (machineScans.get(mk) || 0) + 1);
  }

  // Per product, from the work order each scan belongs to.
  const productMap = new Map();
  for (const e of scans) {
    if (!e.barcodeId) continue;
    const wo = woInfo.get(String(e.workOrderKey || "")) || {};
    const label = wo.productName || "(work order not in register)";
    if (!productMap.has(label)) {
      productMap.set(label, {
        productName: label,
        productCode: wo.productCode || "",
        customerName: wo.customerName || "",
        workOrders: new Set(),
        keys: new Set(),
        scans: 0,
      });
    }
    const row = productMap.get(label);
    row.scans += 1;
    row.keys.add(pieceKeyOf(e));
    if (e.workOrderKey) row.workOrders.add(e.workOrderKey);
  }

  const workedMinutes = operatorStats.reduce(
    (n, o) => n + (o.minutesLoggedIn || 0),
    0
  );
  const breakMinutes = operatorStats.reduce((n, o) => n + (o.breakMinutes || 0), 0);
  const idleMinutes = operatorStats.reduce((n, o) => n + (o.idleMinutes || 0), 0);

  return {
    shiftDate,
    dayKey: dayKeyOf(shiftDate),
    hasData: scans.length > 0,
    totals: {
      pieces,
      scanEvents: scans.length,
      repeatScans: Math.max(0, scans.length - pieces),
      allEvents: events.length,
      operators: new Set(scans.map((e) => e.operatorId).filter(Boolean)).size,
      machines: new Set(scans.map((e) => String(e.machineId))).size,
      orders: new Set(scans.map((e) => e.workOrderKey).filter(Boolean)).size,
      workedMinutes: round1(workedMinutes),
      breakMinutes: round1(breakMinutes),
      idleMinutes: round1(idleMinutes),
    },
    pace: {
      byOperation: paceOps,
      byOperator: paceByOperator,
      byMachine: paceByMachine,
      totalSamSeconds: paceSam,
      totalActualSeconds: paceActual,
      intervals: paceIntervalCount,
      /* Kept separate because they answer a different question: how many
         operation-measurements were taken, not how many garment-intervals. */
      operationIntervals: paceOps.reduce((n, o) => n + (o.intervals || 0), 0),
      excludedSeconds: paceOps.reduce((n, o) => n + (o.excludedSeconds || 0), 0),
      excludedStops: paceOps.reduce((n, o) => n + (o.excluded?.longGaps || 0), 0),
      excludedBreaks: paceOps.reduce((n, o) => n + (o.excluded?.breaks || 0), 0),
      excludedRepeats: paceOps.reduce((n, o) => n + (o.excluded?.repeats || 0), 0),
      averageActualSeconds: paceIntervalCount > 0 ? paceActual / paceIntervalCount : null,
      /* Any operation flagged as batch-scanned makes the day figure suspect
         too — it is built from the same intervals. */
      batchScanning: paceOps.some((o) => o.batchScanning),
      caveat: (paceOps.find((o) => o.caveat) || {}).caveat || null,
      /* Only the codes this day actually used — a conflict on an operation
         nobody ran is a master-data chore, not a warning about this report. */
      samConflicts: samConflicts.filter((c) => Object.prototype.hasOwnProperty.call(usedCodes, c.code)),
      pacePercent: paceActual > 0 ? Math.round((paceSam / paceActual) * 1000) / 10 : null,
    },
    products: [...productMap.values()]
      .map((p) => ({
        productName: p.productName,
        productCode: p.productCode,
        customerName: p.customerName,
        garments: p.keys.size,
        scans: p.scans,
        workOrders: [...p.workOrders].join(", "),
      }))
      .sort((a, b) => b.garments - a.garments),
    operators: operatorStats
      .map((o) => ({
        operatorId: o.operatorId,
        operatorName: o.operatorName || nameFor(o.operatorId),
        garments: operatorPieces.get(String(o.operatorId))?.size ?? 0,
        rollupGarments: o.totalPieces ?? null,
        minutesLoggedIn: o.minutesLoggedIn ?? null,
        productiveMinutes: o.productiveMinutes ?? null,
        idleMinutes: o.idleMinutes ?? null,
        breakMinutes: o.breakMinutes ?? null,
        earnedMinutes: o.earnedMinutes ?? null,
        availableMinutes: o.availableMinutes ?? null,
        efficiencyPercent: o.overallEfficiencyPercent ?? null,
        machines: (o.machinesWorked || [])
          .map((m) => machineName.get(String(m.machineId)) || "")
          .filter(Boolean)
          .join(", "),
        operations: (o.byOperation || []).map((b) => b.operationCode).join(", "),
      }))
      .sort((a, b) => (b.garments || 0) - (a.garments || 0)),
    machines: machineStats
      .map((m) => ({
        machineId: String(m.machineId),
        machineName: machineName.get(String(m.machineId)) || "Unknown machine",
        machineType: machineType.get(String(m.machineId)) || "",
        status: m.status || "",
        garments: machinePieces.get(String(m.machineId))?.size ?? 0,
        rollupGarments: m.totalPieces ?? null,
        scanEvents: machineScans.get(String(m.machineId)) ?? 0,
        suppressedRescans: m.suppressedRescans ?? null,
        operations: (m.byOperation || []).map((b) => b.operationCode).join(", "),
        operators: (m.operatorSpans || [])
          .map((s) => s.operatorName || nameFor(s.operatorId))
          .filter(Boolean)
          .join(", "),
        lastScanAt: m.lastScanAt || null,
      }))
      .sort((a, b) => (b.garments || 0) - (a.garments || 0)),
    scanRows,
  };
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/**
 * Narrow a gathered day to the operator / machine / product asked for.
 *
 * Applied AFTER gathering rather than inside the queries, for the reason this
 * file exists: the scan rows, the per-entity sheets and the totals must all be
 * the same subset. Filtering once, here, means a filtered Excel and a filtered
 * preview cannot disagree.
 *
 * An empty filter is not a filter — "all" is simply the absence of a value.
 */
function applyFilters(day, filters) {
  const wantOperator = filters.operatorId ? String(filters.operatorId) : null;
  const wantMachine = filters.machineId ? String(filters.machineId) : null;
  const wantProduct = filters.productName ? String(filters.productName) : null;
  if (!wantOperator && !wantMachine && !wantProduct) return day;

  const rows = day.scanRows.filter(
    (r) =>
      (!wantOperator || String(r.operatorId) === wantOperator) &&
      (!wantMachine || String(r.machineId) === wantMachine) &&
      (!wantProduct || r.productName === wantProduct)
  );

  /* Recount from the surviving rows, so a filtered total is the total of what is
     shown rather than the unfiltered figure with rows hidden beneath it. The
     piece key is rebuilt from the row's own barcode and operations — the same
     identity countDistinctPieces uses. */
  const keyOf = (r) =>
    `${r.barcodeId}|${String(r.operations || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .sort()
      .join(",")}`;
  const keys = new Set(rows.filter((r) => r.barcodeId).map(keyOf));

  return {
    ...day,
    hasData: rows.length > 0,
    filtered: true,
    totals: {
      ...day.totals,
      pieces: keys.size,
      scanEvents: rows.length,
      repeatScans: Math.max(0, rows.length - keys.size),
      operators: new Set(rows.map((r) => r.operatorId).filter(Boolean)).size,
      machines: new Set(rows.map((r) => r.machineId).filter(Boolean)).size,
      orders: new Set(rows.map((r) => r.workOrder).filter(Boolean)).size,
      /* Attendance, break and idle are per-person facts covering a whole shift.
         They cannot be apportioned to a subset of that person's scans, so a
         report filtered by machine or product reports them as not applicable
         rather than inventing a share. Filtering by operator keeps them,
         because then the subset IS that person. */
      workedMinutes: wantOperator ? day.totals.workedMinutes : null,
      breakMinutes: wantOperator ? day.totals.breakMinutes : null,
      idleMinutes: wantOperator ? day.totals.idleMinutes : null,
    },
    products: day.products.filter((p) => !wantProduct || p.productName === wantProduct),
    operators: day.operators.filter(
      (o) => !wantOperator || String(o.operatorId) === wantOperator
    ),
    machines: day.machines.filter((m) => !wantMachine || String(m.machineId) === wantMachine),
    scanRows: rows,
  };
}

// ─── Periods ──────────────────────────────────────────────────────────────────

/**
 * Turn a named period into a pair of day keys, in IST.
 *
 * "week" and "month" mean the CURRENT week and month TO DATE, not a rolling
 * 7 or 30 days — somebody asking for "this month" on the 3rd wants the 3rd of
 * this month, not the 3rd of last month onward.
 */
function periodRange(period, anchorKey) {
  const anchor = anchorKey || dayKeyOf(currentShiftDate());
  const [y, m, d] = anchor.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  const key = (dt) => dt.toISOString().slice(0, 10);

  switch (period) {
    case "yesterday": {
      const p = new Date(at);
      p.setUTCDate(p.getUTCDate() - 1);
      return { from: key(p), to: key(p) };
    }
    case "week": {
      // Monday-start, the way a production week is read on a floor.
      const dow = (at.getUTCDay() + 6) % 7;
      const start = new Date(at);
      start.setUTCDate(start.getUTCDate() - dow);
      return { from: key(start), to: anchor };
    }
    case "month":
      return { from: key(new Date(Date.UTC(y, m - 1, 1))), to: anchor };
    case "today":
    default:
      return { from: anchor, to: anchor };
  }
}

// ─── The one entry point ──────────────────────────────────────────────────────

/**
 * Build the report for a period, with optional filters.
 *
 * @param {object} opts
 *   from, to     day keys ("YYYY-MM-DD"); a reversed pair is a typo, not an
 *                error, and is sorted rather than refused
 *   period       "today" | "yesterday" | "week" | "month" — overrides from/to
 *   operatorId, machineId, productName   optional filters
 * @returns {Promise<object>} { generatedAt, range, filters, filterLabels, totals, days }
 */
async function buildReport(opts = {}) {
  const filters = {
    operatorId: opts.operatorId || null,
    machineId: opts.machineId || null,
    productName: opts.productName || null,
  };

  let fromKey = opts.from;
  let toKey = opts.to;
  if (opts.period && opts.period !== "custom") {
    const r = periodRange(opts.period, opts.anchor);
    fromKey = r.from;
    toKey = r.to;
  }

  const a = parseDayKey(fromKey) || parseDayKey(dayKeyOf(currentShiftDate()));
  const b = parseDayKey(toKey) || a;
  const av = new Date(Date.UTC(a.y, a.m - 1, a.d));
  const bv = new Date(Date.UTC(b.y, b.m - 1, b.d));
  const ordered = av <= bv ? { a, b } : { a: b, b: a };

  const dates = shiftDatesBetween(ordered.a, ordered.b);
  if (dates.length > MAX_DAYS) {
    const err = new Error(
      `That range is ${dates.length} days. Ask for ${MAX_DAYS} or fewer.`
    );
    err.statusCode = 400;
    throw err;
  }

  const master = await masterData.getMasterData();
  const days = [];
  for (const d of dates) days.push(applyFilters(await gatherDay(d, master, filters), filters));

  const sum = (f) => days.reduce((n, d) => n + (f(d) || 0), 0);
  const uniq = (f) => new Set(days.flatMap(f)).size;

  return {
    generatedAt: new Date(),
    range: {
      from: days.length ? days[0].dayKey : null,
      to: days.length ? days[days.length - 1].dayKey : null,
      days: days.length,
      period: opts.period || "custom",
    },
    filters,
    /* What the filter values MEAN, so a preview or a report header can name the
       person or machine rather than echoing an id nobody recognises. */
    filterLabels: {
      operator: filters.operatorId
        ? days
            .flatMap((d) => d.operators)
            .find((o) => String(o.operatorId) === String(filters.operatorId))
            ?.operatorName || filters.operatorId
        : "All",
      machine: filters.machineId
        ? days
            .flatMap((d) => d.machines)
            .find((m) => String(m.machineId) === String(filters.machineId))
            ?.machineName || filters.machineId
        : "All",
      product: filters.productName || "All",
    },
    totals: {
      pieces: sum((d) => d.totals.pieces),
      scanEvents: sum((d) => d.totals.scanEvents),
      repeatScans: sum((d) => d.totals.repeatScans),
      allEvents: sum((d) => d.totals.allEvents),
      workedMinutes: round1(sum((d) => d.totals.workedMinutes)),
      breakMinutes: round1(sum((d) => d.totals.breakMinutes)),
      idleMinutes: round1(sum((d) => d.totals.idleMinutes)),
      /* Distinct ACROSS the period: somebody who worked every day is one person,
         not seven. Summing the daily counts would say otherwise. */
      operators: uniq((d) => d.operators.map((o) => o.operatorId)),
      machines: uniq((d) => d.machines.map((m) => m.machineId)),
      products: uniq((d) => d.products.map((p) => p.productName)),
      datesWithData: days.filter((d) => d.hasData).length,
      /* PERIOD PACE. Summed as standard-seconds over counted-seconds across
         every day, then divided once — a mean of the daily percentages would
         weight a two-garment Tuesday the same as a full Wednesday. */
      paceSamSeconds: sum((d) => d.pace?.totalSamSeconds),
      paceActualSeconds: sum((d) => d.pace?.totalActualSeconds),
      paceIntervals: sum((d) => d.pace?.intervals),
      paceExcludedSeconds: sum((d) => d.pace?.excludedSeconds),
      /* Carried up so no format can print the period figure without the reason
         it might not mean what it looks like. */
      /* Deduplicated across days: one bad master row is one problem, however
         many days it touched. */
      samConflicts: [
        ...new Map(
          days.flatMap((d) => d.pace?.samConflicts || []).map((c) => [c.code, c])
        ).values(),
      ],
      paceBatchScanning: days.some((d) => d.pace?.batchScanning),
      paceCaveat: (days.find((d) => d.pace?.caveat) || {}).pace?.caveat || null,
      pacePercent: (() => {
        const a = sum((d) => d.pace?.totalSamSeconds);
        const b = sum((d) => d.pace?.totalActualSeconds);
        return b > 0 ? Math.round((a / b) * 1000) / 10 : null;
      })(),
      scanRows: sum((d) => d.scanRows.length),
    },
    days,
  };
}

/** Options a filter UI can offer, drawn from the register rather than guessed. */
/**
 * The most recent shift day that has any scan on it.
 *
 * The dashboard opens on today, and on a day the floor has not run yet that
 * means every card reads zero — which looks like a broken page rather than an
 * idle morning. Knowing the last day with production lets the page offer to go
 * there instead of leaving the reader to guess a date.
 *
 * @returns {Promise<string|null>} a YYYY-MM-DD shift day, or null if there has
 *   never been a scan.
 */
async function latestDayWithData() {
  const newest = await ProductionEvent.findOne({ type: "scan" })
    .sort({ shiftDate: -1 })
    .select({ shiftDate: 1 })
    .lean();
  return newest?.shiftDate ? dayKeyOf(newest.shiftDate) : null;
}

async function filterOptions() {
  const master = await masterData.getMasterData();
  return {
    latestDayWithData: await latestDayWithData(),
    operators: (master.operators || [])
      .map((e) => ({
        id: e.identityId || e.biometricId || "",
        name: [e.firstName, e.lastName].filter(Boolean).join(" ").trim(),
      }))
      .filter((o) => o.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
    machines: (master.machines || [])
      .map((m) => ({ id: String(m._id), name: m.name || "", type: m.type || "" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    products: [
      ...new Set((master.workOrders || []).map((w) => w.stockItemName).filter(Boolean)),
    ].sort(),
  };
}

module.exports = {
  buildReport,
  filterOptions,
  latestDayWithData,
  periodRange,
  parseDayKey,
  dayKeyOf,
  shiftDatesBetween,
  MAX_DAYS,
};
