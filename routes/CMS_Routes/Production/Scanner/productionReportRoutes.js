// routes/CMS_Routes/Production/Scanner/productionReportRoutes.js
//
// THE REPORT, IN FOUR FORMATS AND ONE CALCULATION.
//
// Preview, Excel, PDF and CSV are renderers. Every one of them calls
// buildReport() in services/production/reportBuilder.js and formats what comes
// back; not one of them counts anything itself. That is the only way the number
// on screen and the number in the downloaded file can be guaranteed to match,
// and it is why the gathering was moved out of this file.
//
//   GET /report/filters    what a filter UI may offer
//   GET /report/preview    JSON — the figures, before committing to a file
//   GET /report/xlsx       multi-sheet workbook
//   GET /report/pdf        a laid-out report
//   GET /report/csv        the transaction rows, flat
//
// All five take the same query — from/to or period, plus operatorId, machineId,
// productName — so identical parameters give identical numbers everywhere,
// because they are the same call.

"use strict";

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const reportBuilder = require("../../../../services/production/reportBuilder");
/* For the shift-date helper and to re-run the rollup after a delete, so the
   derived day stats cannot outlive the events they were built from. */
const rollupStats = require("../../../../services/barcodeScanner/rollupStats");

/* Same auth as every other production surface. Carried by the router itself,
   the way the scanner routers do it, so moving the mount cannot open it. */
router.use(EmployeeAuthMiddleware);

/** The query every format shares, so they cannot drift apart. */
function readOptions(req) {
  return {
    from: req.query.from || req.query.date,
    to: req.query.to || req.query.date || req.query.from,
    period: req.query.period || null,
    anchor: req.query.anchor || null,
    operatorId: req.query.operatorId || null,
    machineId: req.query.machineId || null,
    productName: req.query.productName || null,
  };
}

function fail(res, error, where) {
  const code = error.statusCode || 500;
  if (code !== 400) console.error(`[production-report:${where}]`, error.message);
  if (!res.headersSent) {
    res.status(code).json({
      success: false,
      message: code === 400 ? error.message : "Server error",
      ...(code === 400 ? {} : { error: error.message }),
    });
  }
}

const rangeWords = (r) =>
  r.range.from === r.range.to ? r.range.from : `${r.range.from} to ${r.range.to}`;

const metaLine = (r) =>
  `Generated ${r.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · GRAV Production`;

const filterWords = (r) =>
  `Operator: ${r.filterLabels.operator} · Product: ${r.filterLabels.product} · Machine: ${r.filterLabels.machine}`;

const mins = (v) => (v == null ? "" : v);

/** m:ss — §14 and §15 state times that way, and "710" is not a time. */
const clock = (sec) => {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  /* Whole-day spans reach this now that no gap is discarded as a stop; "401:20"
     is not a time anybody reads as 6h 41m. */
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(mm).padStart(2, "0")}:${ss}`;
  return `${mm}:${ss}`;
};

/* The same duration in words, for the operator section only. "5:42" is read as
   five forty-two by anybody who has not been told the column is minutes and
   seconds, and the operator section is the one part of this report written to
   be handed to the person it measures. Everywhere else keeps clock(), which is
   compact and shared with the CSV and the workbook. */
const durationWords = (sec) => {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s} sec`;
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const r = s % 60;
  if (h > 0) return m ? `${h} hr ${m} min` : `${h} hr`;
  return r ? `${m} min ${r} sec` : `${m} min`;
};

/* One sentence, shared by every format, saying what the denominator contains.
   It stopped being "time spent working" on 2026-09-15 when the idle-gap
   threshold was removed, and a percentage that does not say so invites exactly
   the misreading the change was meant to avoid. */
const BASIS_TEXT =
  "Time between garments, including waiting, thread breaks and time away from the machine. " +
  "This is work done per hour, not how fast the operator sews.";

/* Duplicate operation codes in the master are resolved by keeping the first,
   but resolving is not the same as being right — only the IE study knows which
   standard time is the real one. So every report that USED a conflicted code
   says so, rather than printing a confident percentage built on a coin toss. */
const samConflictLine = (r) => {
  const c = r.totals.samConflicts || [];
  if (c.length === 0) return null;
  return (
    `Master data: ${c.length} operation ${c.length === 1 ? "code appears" : "codes appear"} ` +
    `more than once with different standard times. The first value was used; please correct the ` +
    `operations master. ` +
    c.map((x) => `${x.code} using ${x.using}s, ignored ${x.ignored}s`).join("; ")
  );
};

/* The §14 block for one operation, used by every format so the wording cannot
   drift between the screen, the workbook and the PDF. */
const paceSummaryRows = (o) => [
  ["Operation", o.operationCode],
  ["SAM", clock(o.samSeconds)],
  ["Scans", o.scansConsidered],
  ["Gaps counted", o.intervals],
  ["SAM time", clock(o.totalSamSeconds)],
  ["Time taken", clock(o.totalActualSeconds)],
  ["Time per garment", clock(o.averageActualSeconds)],
  ["Efficiency", o.pacePercent == null ? `N/A — ${o.reason || "insufficient data"}` : `${o.pacePercent}%`],
  /* Since 2026-09-15 no gap is discarded as a stop, so the denominator is
     wall-clock time. Saying so next to the number is the whole reason the
     number is safe to publish. */
  ...(o.basis ? [["What the time includes", o.basis]] : []),
];

// ─── Filters ──────────────────────────────────────────────────────────────────

router.get("/report/filters", async (req, res) => {
  try {
    res.json({ success: true, ...(await reportBuilder.filterOptions()) });
  } catch (error) {
    fail(res, error, "filters");
  }
});

// ─── Per-interval log (§15) ───────────────────────────────────────────────────
//
// ONE OPERATION, ONE DAY, EVERY SCAN. The §14 block on screen is the totals; a
// supervisor who wants to know WHY a figure looks wrong needs the scan that
// caused it, and this is that list.
//
// It is a separate route rather than a flag on /report/preview because a
// preview may span three months across fifty machines, and shipping every
// interval of that to draw one expandable panel would trade a fast screen for
// data nobody looked at. Asking per day-and-operation keeps it bounded.
//
// It goes through buildReport like every other surface, so the log cannot
// disagree with the total it sits under.

/**
 * DELETE /report/scans?day=&operatorId=&machineId=
 *
 * Removes the scan events behind one log — the drawer the operator is looking
 * at, not the database. Built for clearing a test run without hand-editing
 * Mongo.
 *
 * THE SCOPE RAIL IS THE POINT. `day` plus at least one of operatorId or
 * machineId is REQUIRED, so there is no URL that empties a shift, and none at
 * all that empties the collection. A delete button one misclick from Refresh
 * needs a floor under it that a crafted query cannot remove.
 *
 * Only `type: "scan"` goes. Sign-ins, sign-outs and breaks stay, because they
 * are the attendance record — deleting those would rewrite how long somebody
 * was at work, which is a payroll fact and not this button's business.
 *
 * The rollup is re-run afterwards. MachineDayStats and OperatorDayStats are
 * derived from these events, so leaving them would show garments that no longer
 * exist on the very page the drawer opened from.
 */
router.delete("/report/scans", async (req, res) => {
  try {
    const day = req.query.day || req.query.date;
    const operatorId = String(req.query.operatorId || "").trim();
    const machineId = String(req.query.machineId || "").trim();

    if (!day) {
      return res.status(400).json({ success: false, message: "day is required" });
    }
    if (!operatorId && !machineId) {
      return res.status(400).json({
        success: false,
        message:
          "Refusing an unscoped delete. Pass operatorId or machineId — this endpoint " +
          "cannot clear a whole shift.",
      });
    }

    const parsed = new Date(day);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ success: false, message: `Not a date: ${day}` });
    }
    const shiftDate = rollupStats.shiftDateFor(parsed);

    const filter = { shiftDate, type: "scan" };
    if (operatorId) filter.operatorId = operatorId;
    if (machineId) filter.machineId = machineId;

    /* One model registry for both steps. This file does not import the models
       itself, and reaching for a bare `ProductionEvent` here is what made the
       first version answer 500 — getLocalModels() is the same set the rollup
       runs against, so the delete and the recount cannot disagree about which
       collection they mean. */
    const models = rollupStats.getLocalModels();
    const result = await models.ProductionEvent.deleteMany(filter);

    /* Best effort: a failed rollup must not report the delete as failed, since
       the events really are gone. The 60s cycle picks it up regardless. */
    let rollup = "queued";
    try {
      await rollupStats.runOnce(models, shiftDate);
      rollup = "done";
    } catch (err) {
      rollup = `deferred (${err.message})`;
    }

    return res.json({
      success: true,
      deleted: result.deletedCount || 0,
      scope: { day, operatorId: operatorId || null, machineId: machineId || null },
      rollup,
      message:
        `${result.deletedCount || 0} scan${result.deletedCount === 1 ? "" : "s"} deleted. ` +
        `Sign-ins, sign-outs and breaks were kept.`,
    });
  } catch (error) {
    fail(res, error, "delete-scans");
  }
});

router.get("/report/pace-log", async (req, res) => {
  try {
    const day = req.query.day || req.query.date;
    const operation = String(req.query.operation || "").trim();
    const machineId = String(req.query.machineId || "").trim();
    const operatorId = String(req.query.operatorId || "").trim();
    if (!day || (!operation && !machineId && !operatorId)) {
      return res.status(400).json({
        success: false,
        message: "day, plus one of operation, machineId or operatorId, are required",
      });
    }

    /* ASKING FOR A MACHINE OR A PERSON NARROWS THE SCANS FIRST.
       buildReport's filters apply before pace is computed, so the per-operation
       figures that come back already belong to that machine or that operator
       alone. This matters: computed across the floor they would mix machines,
       and the gap between two different people's garments is not a cycle time
       for either of them. */
    const r = await reportBuilder.buildReport({
      ...readOptions(req),
      from: day,
      to: day,
      ...(machineId ? { machineId } : {}),
      ...(operatorId ? { operatorId } : {}),
    });
    const d = (r.days || []).find((x) => x.dayKey === day);
    let ops = (d?.pace?.byOperation || []).filter((o) => o.scansConsidered > 0);
    if (operation) ops = ops.filter((o) => o.operationCode === operation);

    if (ops.length === 0) {
      /* An empty day is the ordinary answer for a floor that did not run, so it
         reads as a sentence rather than an id — the caller shows it verbatim. */
      const who = operation
        ? `operation ${operation}`
        : operatorId
        ? "this person"
        : "this device";
      return res
        .status(404)
        .json({ success: false, message: `Nothing was scanned on ${who} on ${day}` });
    }

    const shape = (op) => {
      /* The first scan opens the sequence and closes nothing, so it carries no
         duration and no percentage — the reference §4 describes. It is not in
         `rows` (which holds intervals, not scans), so it is reconstructed from
         the first interval's `previousAt`. */
      /* THE START POINT IS THE ID CARD.
       *
       * This used to prepend a synthetic "scan 1" built from the first row's
       * previousAt — a row with no barcode, so a garment that really was
       * scanned showed as "—" and was then discarded as unmeasurable. Now each
       * session opens with the sign-in that started it, and every garment
       * after it is timed and named. Indices are assigned here so the sequence
       * reads 1,2,3 down the page including those markers. */
      const scans = [];
      let lastAnchorAt = null;
      let n = 0;
      const rows = op.rows || [];
      if (rows.length && !rows[0].anchoredTo && rows[0].previousAt) {
        /* No sign-in before the first garment: keep the old reference row so
           the sequence still starts somewhere. */
        scans.push({ index: ++n, at: rows[0].previousAt, reference: true });
      }
      for (const row of rows) {
        if (row.anchoredTo && row.anchoredTo.at !== lastAnchorAt) {
          lastAnchorAt = row.anchoredTo.at;
          /* In the order it happened: the absence, then the sign-in that ended
             it, then the garments. Hanging the absence off the garment instead
             is what put an 11:39 sign-out next to a 13:05 scan. */
          /* The absence rides ON the sign-in row rather than getting one of its
             own. As a separate row it was either orphaned at the top of the
             table, explaining a period no work in this log belongs to, or —
             once that was suppressed — missing entirely, so nothing said the
             operator had been away. Attached here it is always present and
             always attached to the thing it explains: why this session
             started. */
          scans.push({
            index: ++n,
            at: row.anchoredTo.at,
            anchorKind: row.anchoredTo.kind,
            awayBefore: row.anchoredTo.after || null,
            reference: true,
          });
        }
        scans.push({
          index: ++n,
          at: row.at,
          barcodeId: row.barcodeId,
          durationSeconds: row.intervalSeconds,
          counted: row.counted,
          anchoredTo: row.anchoredTo || null,
          excludedBecause: row.excludedBecause,
          /* The away span this interval ran across, so the log can show
             "signed out 216s" as its own line and treat the scan after it as a
             fresh start point rather than silently dropping a row. */
          boundary: row.boundary || null,
          /* Per-interval, for THIS ROW ONLY. Never summed anywhere: §7 forbids
             averaging this column, and the overall below is a ratio of totals. */
          efficiencyPercent:
            row.counted && row.intervalSeconds > 0
              ? Math.round((op.samSeconds / row.intervalSeconds) * 10000) / 100
              : null,
        });
      }
      /* The shift ended. Emitted after the last garment, in the position it
         happened, so a finished session reads as finished. */
      if (op.closedBy) {
        scans.push({ closedBy: op.closedBy });
      }

      return {
        operationCode: op.operationCode,
        operationName: op.operationName || "",
        samSeconds: op.samSeconds,
        scans,
        totals: {
          scansConsidered: op.scansConsidered,
          intervals: op.intervals,
          totalSamSeconds: op.totalSamSeconds,
          totalActualSeconds: op.totalActualSeconds,
          averageActualSeconds: op.averageActualSeconds,
          pacePercent: op.pacePercent,
          excluded: op.excluded,
          caveat: op.caveat || null,
          basis: op.basis || null,
        },
      };
    };

    /* THE ONE FIGURE FOR THE DEVICE. Same rule as the day total: a garment
       interval contributes its elapsed seconds ONCE however many operations it
       completed, and earns each of their standard times. Summing the operations
       naively would count the same seconds twice in the denominator. */
    const earned = new Map();
    for (const op of ops) {
      if (!(op.samSeconds > 0)) continue;
      for (const row of op.rows || []) {
        if (!row.counted) continue;
        const k = `${new Date(row.previousAt).getTime()}|${new Date(row.at).getTime()}|${row.barcodeId}`;
        const cur = earned.get(k);
        if (cur) cur.sam += op.samSeconds;
        else earned.set(k, { seconds: row.intervalSeconds, sam: op.samSeconds });
      }
    }
    let sam = 0;
    let actual = 0;
    for (const v of earned.values()) {
      sam += v.sam;
      actual += v.seconds;
    }

    res.json({
      success: true,
      dayKey: day,
      machineId: machineId || null,
      machineName:
        (d?.machines || []).find((m) => String(m.machineId) === machineId)?.machineName || null,
      operatorId: operatorId || null,
      operatorName:
        (d?.operators || []).find((o) => String(o.operatorId) === operatorId)?.operatorName || null,
      operations: ops.map(shape),
      /* THE EFFICIENCY FIGURE, which is not the pace figure.
       *
       * pacePercent below divides standard time by the gaps BETWEEN scans, so
       * it answers "while they were going, how fast" — and it can exceed 100%
       * honestly, because two garments scanned 80 seconds apart really were 80
       * seconds apart. What it cannot do is describe a shift: the time before
       * the first scan, after the last, and every excluded stoppage are all
       * outside its denominator.
       *
       * Standard garment-industry efficiency divides earned standard minutes by
       * ATTENDED minutes less breaks. The rollup already computes exactly that
       * (rollupStats overallEfficiencyPercent), so this reports it rather than
       * deriving a second version that could disagree with the rest of the CMS.
       *
       * Sent alongside its own components so the screen can show the working
       * instead of asking anyone to trust a bare percentage.
       */
      efficiency: (() => {
        if (!operatorId) return null; // machines have no attendance of their own here
        const o = (d?.operators || []).find((x) => String(x.operatorId) === operatorId);
        if (!o) return null;
        const attendance = o.minutesLoggedIn;
        const breaks = o.breakMinutes || 0;
        const worked = attendance != null ? Math.max(0, attendance - breaks) : null;
        return {
          percent: o.efficiencyPercent ?? null,
          earnedMinutes: o.earnedMinutes ?? null,
          attendanceMinutes: attendance,
          breakMinutes: breaks,
          workedMinutes: worked == null ? null : Math.round(worked * 10) / 10,
          basis: "earned standard minutes ÷ attended minutes less breaks",
        };
      })(),

      overall: {
        intervals: earned.size,
        totalSamSeconds: sam,
        totalActualSeconds: actual,
        averageActualSeconds: earned.size > 0 ? actual / earned.size : null,
        pacePercent: actual > 0 ? Math.round((sam / actual) * 1000) / 10 : null,
        garments: Math.max(...ops.map((o) => o.scansConsidered), 0),
        caveat: (ops.find((o) => o.caveat) || {}).caveat || null,
        basis: (ops.find((o) => o.basis) || {}).basis || null,
      },
    });
  } catch (error) {
    fail(res, error, "pace-log");
  }
});

// ─── Preview ──────────────────────────────────────────────────────────────────
//
// The same object the exports render, minus the per-scan rows — those are what
// make a download worth having and what would make a preview slow. The count is
// still reported, so the screen can say how many rows a download will contain.

router.get("/report/preview", async (req, res) => {
  try {
    /* scanRows: false — the preview sends scanRowCount, never the rows. */
    const r = await reportBuilder.buildReport({ ...readOptions(req), scanRows: false });
    res.json({
      success: true,
      generatedAt: r.generatedAt,
      range: r.range,
      filters: r.filters,
      filterLabels: r.filterLabels,
      totals: r.totals,
      /* Order progress for the period, garments deduplicated across days. The
         Scan Records page shows "3 of 80 done" from this rather than from the
         old work-orders endpoint, so the two pages cannot disagree about how
         much of an order is finished. */
      workOrders: r.workOrders,
      days: r.days.map((d) => ({
        dayKey: d.dayKey,
        hasData: d.hasData,
        totals: d.totals,
        products: d.products,
        operators: d.operators,
        machines: d.machines,
        /* buildReport's own count, not the array's length — the array is empty
           here because this route asks for scanRows: false, and reading its
           length reported 0 scans on a day that had 13. */
        scanRowCount: d.scanRowCount,
        hourly: d.hourly,
        /* §11 — the figures a report must show: scans, valid intervals, SAM,
           total SAM time, total actual, average actual, overall efficiency.
           The per-interval rows are left out of the preview and kept for the
           detailed downloads, per §14's "do not clutter the main UI". */
        pace: {
          ...d.pace,
          byOperation: (d.pace?.byOperation || []).map(({ rows, ...o }) => o),
        },
      })),
    });
  } catch (error) {
    fail(res, error, "preview");
  }
});

// ─── Excel ────────────────────────────────────────────────────────────────────

const TITLE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };

function writeSheetHead(ws, title, subtitle, meta, filters) {
  ws.mergeCells("A1:D1");
  const t = ws.getCell("A1");
  t.value = title;
  t.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
  t.fill = TITLE_FILL;
  t.alignment = { vertical: "middle" };
  ws.getRow(1).height = 22;

  ws.getCell("A2").value = subtitle;
  ws.getCell("A2").font = { size: 10, color: { argb: "FF475569" } };
  ws.getCell("A3").value = filters;
  ws.getCell("A3").font = { size: 9, color: { argb: "FF64748B" } };
  ws.getCell("A4").value = meta;
  ws.getCell("A4").font = { size: 9, color: { argb: "FF94A3B8" } };
}

function writeHeaderRow(ws, rowNumber, headers) {
  const row = ws.getRow(rowNumber);
  headers.forEach((h, i) => {
    const c = row.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 10 };
    c.fill = HEAD_FILL;
    c.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });
  ws.views = [{ state: "frozen", ySplit: rowNumber }];
}

const colLetter = (n) => {
  let s = "";
  let v = n;
  while (v > 0) {
    const m = (v - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    v = Math.floor((v - m) / 26);
  }
  return s;
};

router.get("/report/xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const r = await reportBuilder.buildReport(readOptions(req));
    const words = rangeWords(r);
    const meta = metaLine(r);
    const filt = filterWords(r);

    const wb = new ExcelJS.Workbook();
    wb.creator = "GRAV Production";
    wb.created = r.generatedAt;

    // 1 ── Report Summary
    const sum = wb.addWorksheet("Report Summary");
    sum.columns = [{ width: 34 }, { width: 18 }, { width: 4 }, { width: 52 }];
    writeSheetHead(sum, "Production Report", `Covering ${words}`, meta, filt);
    writeHeaderRow(sum, 6, ["Metric", "Value", "", "Notes"]);
    const summaryRows = [
      ["Dates covered", r.range.days, "", r.range.days === 1 ? "single date" : "date range"],
      ["Dates with production", r.totals.datesWithData, "", ""],
      ["Garments finished", r.totals.pieces, "", "distinct pieces; a piece scanned twice counts once"],
      ["Scans recorded", r.totals.scanEvents, "", "every read the scanner sent"],
      ["Repeat scans", r.totals.repeatScans, "", "reads of a piece already counted — not production"],
      ["Operators who worked", r.totals.operators, "", "distinct across the period"],
      ["Machines used", r.totals.machines, "", "distinct across the period"],
      ["Products made", r.totals.products, "", ""],
      ["Time worked (minutes)", mins(r.totals.workedMinutes), "", "attendance, sign-in to sign-out"],
      ["Break time (minutes)", mins(r.totals.breakMinutes), "", ""],
      ["Idle time (minutes)", mins(r.totals.idleMinutes), "", "manned but not scanning"],
      ["Transaction rows", r.totals.scanRows, "", "see the Scan Activity sheet"],
      /* §14 at the top of the workbook, so the headline figure is on the sheet
         that opens rather than only on the seventh one. */
      [
        "Work produced vs standard time",
        r.totals.pacePercent == null ? "N/A" : `${r.totals.pacePercent}%`,
        "",
        `${clock(r.totals.paceSamSeconds)} of standard work over ${clock(r.totals.paceActualSeconds)} ` +
          `elapsed (${r.totals.paceIntervals} intervals). Waiting time is included — this is ` +
          `output per hour present, not working speed.` +
          (r.totals.paceCaveat ? ` ${r.totals.paceCaveat}` : ""),
      ],
    ];
    const conflictWarning = samConflictLine(r);
    if (conflictWarning) summaryRows.push(["Master data warning", "CHECK", "", conflictWarning]);
    summaryRows.forEach((v, i) => {
      const row = sum.getRow(7 + i);
      row.values = v;
      row.getCell(2).numFmt = "#,##0.#";
      row.getCell(4).font = {
        size: 9,
        italic:
          (v[0] === "Work produced vs standard time" && !!r.totals.paceCaveat) ||
          v[0] === "Master data warning",
        color: {
          argb:
            (v[0] === "Work produced vs standard time" && r.totals.paceCaveat) ||
            v[0] === "Master data warning"
              ? "FFB45309"
              : "FF64748B",
        },
      };
      row.getCell(4).alignment = { wrapText: true, vertical: "top" };
    });

    // 2 ── Date-wise Summary
    const byDate = wb.addWorksheet("Date-wise Summary");
    byDate.columns = [
      { width: 13 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 },
      { width: 11 }, { width: 10 }, { width: 13 }, { width: 12 }, { width: 12 }, { width: 46 },
    ];
    writeSheetHead(byDate, "Date-wise Summary", `Covering ${words}`, meta, filt);
    writeHeaderRow(byDate, 6, [
      "Date", "Garments", "Scans", "Repeats", "Operators", "Machines",
      "Orders", "Worked (min)", "Break (min)", "Idle (min)", "Note",
    ]);
    r.days.forEach((d, i) => {
      const row = byDate.getRow(7 + i);
      row.values = [
        d.dayKey, d.totals.pieces, d.totals.scanEvents, d.totals.repeatScans,
        d.totals.operators, d.totals.machines, d.totals.orders,
        mins(d.totals.workedMinutes), mins(d.totals.breakMinutes), mins(d.totals.idleMinutes),
        d.hasData ? "" : "No data available — nothing was scanned on this date",
      ];
      if (!d.hasData) row.font = { color: { argb: "FF94A3B8" }, italic: true };
    });
    /* A period total on the sheet itself, so it adds up without the reader
       having to trust another tab. */
    const totalRow = byDate.getRow(7 + r.days.length);
    totalRow.values = [
      "TOTAL", r.totals.pieces, r.totals.scanEvents, r.totals.repeatScans,
      r.totals.operators, r.totals.machines, "",
      mins(r.totals.workedMinutes), mins(r.totals.breakMinutes), mins(r.totals.idleMinutes),
      "operators and machines are distinct across the period, not a column sum",
    ];
    totalRow.font = { bold: true };
    totalRow.border = { top: { style: "thin", color: { argb: "FF94A3B8" } } };
    byDate.autoFilter = { from: "A6", to: `K${6 + r.days.length}` };

    // 3-5 ── per-entity detail
    const detail = [
      {
        name: "Product Details",
        widths: [13, 34, 20, 24, 12, 10, 34],
        headers: ["Date", "Product", "Product code", "Customer", "Garments", "Scans", "Work orders"],
        rows: (d) =>
          d.products.map((p) => [
            d.dayKey, p.productName, p.productCode, p.customerName, p.garments, p.scans, p.workOrders,
          ]),
      },
      {
        name: "Operator Details",
        widths: [13, 14, 26, 34, 9, 15, 12, 12, 14, 15, 11, 11, 13, 14, 30],
        headers: [
          "Date", "Operator ID", "Operator", "Work done (operation)", "Pieces",
          "Should take /pc", "Took /pc", "Efficiency %",
          "Logged in (min)", "Productive (min)", "Idle (min)", "Break (min)",
          "Earned (min)", "Available (min)", "Machines",
        ],
        rows: (d) =>
          d.operators.map((o) => [
            d.dayKey, o.operatorId, o.operatorName,
            o.operationNames || o.operations, mins(o.garments),
            clock(o.shouldSecPerPiece), clock(o.tookSecPerPiece), mins(o.efficiencyPercent),
            mins(o.minutesLoggedIn), mins(o.productiveMinutes), mins(o.idleMinutes),
            mins(o.breakMinutes), mins(o.earnedMinutes), mins(o.availableMinutes),
            o.machines,
          ]),
      },
      {
        name: "Machine Details",
        widths: [13, 24, 14, 16, 11, 10, 14, 26, 34, 20],
        headers: [
          "Date", "Machine", "Type", "Status", "Garments", "Scans",
          "Rescans dropped", "Operations", "Operators", "Last scan",
        ],
        rows: (d) =>
          d.machines.map((m) => [
            d.dayKey, m.machineName, m.machineType, m.status, mins(m.garments),
            mins(m.scanEvents), mins(m.suppressedRescans), m.operations, m.operators,
            m.lastScanAt ? new Date(m.lastScanAt).toISOString().slice(0, 19).replace("T", " ") : "",
          ]),
      },
    ];

    for (const spec of detail) {
      const ws = wb.addWorksheet(spec.name);
      ws.columns = spec.widths.map((w) => ({ width: w }));
      writeSheetHead(ws, spec.name, `Covering ${words}`, meta, filt);
      writeHeaderRow(ws, 6, spec.headers);
      let rn = 7;
      for (const d of r.days) {
        const list = spec.rows(d);
        if (list.length === 0) {
          const row = ws.getRow(rn++);
          row.values = [d.dayKey, "No data available for this date"];
          row.font = { color: { argb: "FF94A3B8" }, italic: true };
          continue;
        }
        for (const v of list) ws.getRow(rn++).values = v;
      }
      ws.autoFilter = { from: "A6", to: `${colLetter(spec.headers.length)}${Math.max(6, rn - 1)}` };
    }

    // 6 ── Scan Activity, the transaction level
    const act = wb.addWorksheet("Scan Activity");
    act.columns = [
      { width: 20 }, { width: 13 }, { width: 10 }, { width: 22 }, { width: 8 },
      { width: 22 }, { width: 14 }, { width: 24 }, { width: 16 }, { width: 34 },
      { width: 16 }, { width: 30 }, { width: 20 }, { width: 24 }, { width: 20 }, { width: 14 },
    ];
    writeSheetHead(act, "Scan Activity", `Every scan recorded, ${words}`, meta, filt);
    writeHeaderRow(act, 6, [
      "Timestamp (UTC)", "Date", "Time", "Barcode", "Unit", "Machine", "Operator ID",
      "Operator", "Operation codes", "Operation names", "Work order", "Product",
      "Product code", "Customer", "Counts as production", "Device",
    ]);
    let ar = 7;
    for (const d of r.days) {
      if (d.scanRows.length === 0) {
        const row = act.getRow(ar++);
        row.values = ["", d.dayKey, "", "No data available for this date"];
        row.font = { color: { argb: "FF94A3B8" }, italic: true };
        continue;
      }
      for (const s of d.scanRows) {
        const iso = new Date(s.at).toISOString();
        const row = act.getRow(ar++);
        row.values = [
          iso.slice(0, 19).replace("T", " "), d.dayKey, iso.slice(11, 19),
          s.barcodeId, s.unitNumber, s.machineName, s.operatorId, s.operatorName,
          s.operations, s.operationNames, s.workOrder, s.productName,
          s.productCode, s.customerName, s.countsAsProduction, s.deviceId,
        ];
        // The row a supervisor is usually hunting for.
        if (s.countsAsProduction !== "Yes") row.font = { color: { argb: "FFB45309" } };
      }
    }
    act.autoFilter = { from: "A6", to: `P${Math.max(6, ar - 1)}` };

    // 7 ── Efficiency (SAM vs actual), §14 summary then §15 interval detail
    const pace = wb.addWorksheet("Efficiency (SAM)");
    pace.columns = [
      { width: 13 }, { width: 12 }, { width: 22 }, { width: 22 },
      { width: 16 }, { width: 14 }, { width: 22 }, { width: 30 },
    ];
    writeSheetHead(
      pace,
      "Efficiency against standard time",
      `SAM time / time taken between garments (waiting included) · ${words}`,
      meta,
      filt
    );
    let pr = 6;
    for (const d of r.days) {
      const ops = (d.pace?.byOperation || []).filter((o) => o.scansConsidered > 0);
      if (ops.length === 0) continue;

      const dayCell = pace.getRow(pr++);
      dayCell.values = [d.dayKey];
      dayCell.font = { bold: true, size: 11 };

      for (const o of ops) {
        // §14 — the overall result, stated as a block.
        writeHeaderRow(pace, pr, ["", "", "Figure", "Value", "", "", "", ""]);
        pr += 1;
        for (const [label, value] of paceSummaryRows(o)) {
          const row = pace.getRow(pr++);
          row.values = ["", "", label, value];
          if (label === "Overall efficiency") row.font = { bold: true };
        }
        if (o.caveat) {
          const c = pace.getRow(pr++);
          c.values = ["", "", "Data note", o.caveat];
          c.font = { size: 9, italic: true, color: { argb: "FFB45309" } };
        }

        // §15 — every interval behind that figure.
        pr += 1;
        writeHeaderRow(pace, pr, [
              "Scan #", "Operation", "Scan time", "Previous scan",
          "Time taken", "Counted", "Left out because", "Barcode",
        ]);
        pr += 1;
        for (const row of o.rows || []) {
          const line = pace.getRow(pr++);
          line.values = [
            row.index,
            o.operationCode,
            new Date(row.at).toISOString().slice(11, 19),
            row.previousAt ? new Date(row.previousAt).toISOString().slice(11, 19) : "—",
            clock(row.intervalSeconds),
            row.counted ? "Yes" : "No",
            row.excludedBecause || "",
            row.barcodeId,
          ];
          if (!row.counted) line.font = { color: { argb: "FF94A3B8" } };
        }
        pr += 1;
      }
    }
    if (pr === 6) {
      const none = pace.getRow(6);
      none.values = ["No scans in this period, so there is nothing to measure against SAM."];
      none.font = { italic: true, color: { argb: "FF94A3B8" } };
    }

    const file = r.range.from === r.range.to ? r.range.from : `${r.range.from}_to_${r.range.to}`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename=grav-production-${file}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      return res
        .status(500)
        .json({ success: false, message: "exceljs not installed. Run: npm install exceljs" });
    }
    fail(res, error, "xlsx");
  }
});

// ─── CSV ──────────────────────────────────────────────────────────────────────
//
// The transaction rows, flat. CSV has no sheets, so this is deliberately the
// scan-level data rather than a squashed summary: the summary reads better in
// the preview or the PDF, and what CSV is actually good for is being loaded
// somewhere else. The period's headline figures ride along as comment lines so
// the file can still be checked against the screen it came from.

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get("/report/csv", async (req, res) => {
  try {
    const r = await reportBuilder.buildReport(readOptions(req));
    /* §15's interval columns ride on the scan rows rather than in a second file:
       CSV has one table, and a reader filtering to an operation gets that
       operation's sequence with its gaps already attached. The per-operation
       totals are in the comment header above, and in full on the Excel sheet. */
    const head = [
      "Timestamp UTC", "Date", "Time", "Barcode", "Unit", "Machine", "Operator ID",
      "Operator", "Operation codes", "Operation names", "Work order", "Product",
      "Product code", "Customer", "Counts as production", "Device",
    ];
    const lines = [
      `# GRAV Production Report - ${rangeWords(r)}`,
      `# ${filterWords(r)}`,
      `# ${metaLine(r)}`,
      `# Garments ${r.totals.pieces} | Scans ${r.totals.scanEvents} | Repeat scans ${r.totals.repeatScans}`,
      `# Work produced vs SAM: ${r.totals.pacePercent == null ? "N/A" : r.totals.pacePercent + "%"} ` +
        `over ${r.totals.paceIntervals} intervals ` +
        `(standard ${clock(r.totals.paceSamSeconds)} / elapsed ${clock(r.totals.paceActualSeconds)})`,
      `# Basis: ${BASIS_TEXT}`,
      ...(samConflictLine(r) ? [`# WARNING: ${samConflictLine(r)}`] : []),
    ];
    /* A bare percentage in a comment line travels further than the report it
       came from. If the intervals say the garments were scanned in batches, the
       caveat travels with it. */
    if (r.totals.paceCaveat) lines.push(`# Note: ${r.totals.paceCaveat}`);
    lines.push(head.join(","));
    for (const d of r.days) {
      if (d.scanRows.length === 0) {
        lines.push(`,${d.dayKey},,No data available for this date`);
        continue;
      }
      for (const s of d.scanRows) {
        const iso = new Date(s.at).toISOString();
        lines.push(
          [
            iso.slice(0, 19).replace("T", " "), d.dayKey, iso.slice(11, 19),
            s.barcodeId, s.unitNumber, s.machineName, s.operatorId, s.operatorName,
            s.operations, s.operationNames, s.workOrder, s.productName,
            s.productCode, s.customerName, s.countsAsProduction, s.deviceId,
          ]
            .map(csvCell)
            .join(",")
        );
      }
    }
    const file = r.range.from === r.range.to ? r.range.from : `${r.range.from}_to_${r.range.to}`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=grav-production-${file}.csv`);
    /* A BOM, so Excel opens it as UTF-8 rather than mangling a non-ASCII name in
       the operator or customer columns. */
    res.send("﻿" + lines.join("\n"));
  } catch (error) {
    fail(res, error, "csv");
  }
});

// ─── PDF ──────────────────────────────────────────────────────────────────────

const PDF_MARGIN = 40;

/* ── PDF ──────────────────────────────────────────────────────────────────────
 *
 * THE DOCUMENT AN IE HANDS TO A PRODUCTION MANAGER.
 *
 * Page 1 decides, the rest proves. The manager reads the verdict and the
 * figures; the IE keeps the tables behind them to defend every number when
 * challenged. Nothing is on page 1 that cannot be traced to a table later, and
 * nothing is in a later table that page 1 cannot reach.
 *
 * WHAT THIS REPORT IS NOT. It is a summary, not a log. It says what each person
 * and each machine did and how that compares with standard time. It does not
 * print one line per badge-in or one line per scan: that detail lives in the
 * scan log on the dashboard, where it can be opened for the one person being
 * questioned rather than printed for everybody.
 *
 * ONE EFFICIENCY. Standard time (SAM) earned ÷ real time between finished
 * garments × 100. Floor, operator, machine and operation are the same
 * arithmetic at different scopes, so a row can be checked against its total by
 * eye. It is defined once, on page 1, and every table afterwards just says
 * "Efficiency".
 *
 * THE OLD MEASURE IS GONE, NOT HIDDEN. earned ÷ signed-in minutes, and the
 * columns built from it — "Should take /pc", "Took /pc" and the Worked / Break
 * / Idle minute cards — are removed. The attendance minutes went with them, so
 * that nobody can rebuild the banned ratio by hand out of columns this report
 * printed.
 *
 * WHY SCANS, REPEATS AND SIGN-INS ARE COLUMNS. The floor asked for it: one
 * operator works several machines and badges in many times a day, and printing
 * only the deduplicated garment count hid all of it. On 2026-08-29 one operator
 * made 63 reads that resolved to 26 garments across 6 sign-ins; the old report
 * said "26" and nothing else.
 */
router.get("/report/pdf", async (req, res) => {
  try {
    const PDFDocument = require("pdfkit");
    /* scanRows: false — the PDF has no scan list section. */
    const r = await reportBuilder.buildReport({ ...readOptions(req), scanRows: false });

    const doc = new PDFDocument({ size: "A4", margin: PDF_MARGIN, bufferPages: true });
    const file = r.range.from === r.range.to ? r.range.from : `${r.range.from}_to_${r.range.to}`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=grav-production-${file}.pdf`);
    doc.pipe(res);

    const W = doc.page.width - PDF_MARGIN * 2;
    const BOTTOM = doc.page.height - PDF_MARGIN - 24;

    const ensureRoom = (need, repeatHeader) => {
      if (doc.y + need <= BOTTOM) return;
      doc.addPage();
      if (repeatHeader) repeatHeader();
    };

    const heading = (text, size = 12) => {
      /* A heading must not be the last thing on a page. 40pt was enough for the
         heading itself and nothing else, so "Styles made" printed at the foot of
         a page with its column header, and the first data row — and a repeat of
         the header — began the next one. Reserve the heading, an explanatory
         line, the column header AND one row, so a section always starts with
         something to read under it. */
      ensureRoom(78);
      doc.moveDown(0.6);
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(size)
        .text(text, PDF_MARGIN, doc.y, { width: W });
      doc.moveDown(0.25);
    };

    const prose = (text, opts = {}) => {
      if (!text) return;
      doc.font(opts.font || "Helvetica").fontSize(opts.size || 7.5)
        .fillColor(opts.color || "#64748b")
        .text(text, PDF_MARGIN + (opts.indent || 0), doc.y, {
          width: W - (opts.indent || 0),
        });
      doc.moveDown(opts.gap == null ? 0.25 : opts.gap);
    };

    /* A HEADER IS ALIGNED LIKE THE COLUMN IT NAMES.
       No header row passed `align`, so every one printed flush left while its
       numbers printed flush right: "Garments" sat at the left edge of its
       column and the 5 beneath it sat at the right edge, an inch away. The
       header and its value have to sit in the same place to read as a column,
       and no amount of closing the vertical gap fixes a horizontal one.

       SPACE BELOW A ROW'S TEXT, IN POINTS.
       heightOfString already returns the glyph height plus pdfkit's own line
       gap — 9.52pt for an 8pt header, 9.83pt for an 8.5pt cell — so this is
       padding on top of that, not leading. At 4 a header and the figure under
       it sat 13.5pt apart, about 1.7x the font size, which reads as a gap
       rather than as a table. At 1 the row pitch is ~1.27x — measured from the
       PDF's own content stream, a header baseline and the figure under it sit
       10.9pt apart, of which only ~1.4pt is white space; the rest is the
       descender room inside each line box, which cannot be removed without
       clipping glyphs. Nothing else changes: the same text, the same widths,
       the same wrap heights. */
    const ROW_PAD = 1;

    const tableRow = (cells, widths, opts = {}) => {
      const size = opts.size || 8.5;
      const font = opts.bold ? "Helvetica-Bold" : "Helvetica";
      const wrap = opts.wrap !== false;

      doc.font(font).fontSize(size);
      let tallest = size;
      if (wrap) {
        cells.forEach((c, i) => {
          const h = doc.heightOfString(String(c == null ? "" : c), { width: widths[i] - 4 });
          if (h > tallest) tallest = h;
        });
      }
      if (opts.repeatHeader) ensureRoom(tallest + ROW_PAD + 4, opts.repeatHeader);

      doc.font(font).fontSize(size).fillColor(opts.color || "#0f172a");
      const y = doc.y;
      let x = PDF_MARGIN;
      cells.forEach((c, i) => {
        doc.text(String(c == null ? "" : c), x + 2, y, {
          width: widths[i] - 4,
          align: opts.align && opts.align[i] ? opts.align[i] : "left",
          lineBreak: wrap,
          ellipsis: !wrap,
        });
        x += widths[i];
      });
      doc.x = PDF_MARGIN;
      doc.y = y + tallest + ROW_PAD;
      if (opts.rule) {
        /* Centred in the padding, so the rule does not sit hard against the
           header text nor against the row below it. */
        const ruleY = doc.y - ROW_PAD / 2;
        doc.moveTo(PDF_MARGIN, ruleY).lineTo(PDF_MARGIN + W, ruleY)
          .lineWidth(0.5).strokeColor("#cbd5e1").stroke();
      }
    };

    /* Every clock time in this document is IST: the shift day is an IST day, and
       a report whose dates and times disagreed about the timezone would be
       indefensible the first time it was checked against a machine. */
    const IST = 330 * 60000;
    const two = (n) => String(n).padStart(2, "0");
    const istTime = (d) => {
      if (!d) return "—";
      const t = new Date(new Date(d).getTime() + IST);
      return `${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
    };
    const istStamp = (d) => {
      if (!d) return "—";
      const t = new Date(new Date(d).getTime() + IST);
      return `${t.toISOString().slice(0, 10)} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())} IST`;
    };
    /* The print time is part of the number on purpose: a shift re-run after a
       correction is a different report, and a manager must be able to tell which
       copy is on the desk. */
    const reportNo = (() => {
      const t = new Date(new Date(r.generatedAt).getTime() + IST);
      const hm = `${two(t.getUTCHours())}${two(t.getUTCMinutes())}`;
      return r.range.days === 1
        ? `IE/DPR/${r.range.from.replace(/-/g, "")}-${hm}`
        : `IE/PR/${r.range.from.replace(/-/g, "")}-${r.range.to.replace(/-/g, "")}-${hm}`;
    })();

    const pctText = (sam, actual) =>
      actual > 0 ? `${Math.round((sam / actual) * 1000) / 10}%` : "Not measured";

    /* Codes mean nothing to the person being measured. The only name source on
       this payload is the pre-joined "CODE Name, CODE Name" string on operator
       rows, so it is unpacked once here. */
    const opNames = new Map();
    for (const d of r.days) {
      for (const o of d.operators || []) {
        for (const part of String(o.operationNames || "").split(",")) {
          const v = part.trim();
          const sp = v.indexOf(" ");
          if (sp > 0) opNames.set(v.slice(0, sp), v.slice(sp + 1));
        }
      }
    }
    const opLabel = (code) => {
      const n = opNames.get(String(code).trim());
      return n ? `${code} ${n}` : String(code);
    };

    /** Merge the same entity across every day in the period. */
    const mergeDays = (pick, keyOf, seed, add) => {
      const m = new Map();
      for (const d of r.days) {
        for (const row of pick(d) || []) {
          const k = String(keyOf(row));
          if (!k) continue;
          if (!m.has(k)) m.set(k, seed(row));
          add(m.get(k), row);
        }
      }
      return [...m.values()];
    };

    // ── 1 · Identification ───────────────────────────────────────────────────
    doc.rect(PDF_MARGIN, PDF_MARGIN, W, 52).fill("#1f2937");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(16)
      .text(r.range.days === 1 ? "GRAV — Daily Production Report" : "GRAV — Production Report",
        PDF_MARGIN + 12, PDF_MARGIN + 10, { lineBreak: false });
    doc.font("Helvetica").fontSize(8.5).fillColor("#cbd5e1")
      .text("Industrial Engineering", PDF_MARGIN + 275, PDF_MARGIN + 13,
        { width: 228, align: "right", lineBreak: false });
    doc.font("Helvetica").fontSize(9.5).fillColor("#cbd5e1")
      .text(`Sewing floor · ${rangeWords(r)}`, PDF_MARGIN + 12, PDF_MARGIN + 32, { lineBreak: false });

    const gridY = PDF_MARGIN + 60;
    doc.rect(PDF_MARGIN, gridY, W, 60).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
    doc.moveTo(PDF_MARGIN, gridY + 30).lineTo(PDF_MARGIN + W, gridY + 30)
      .lineWidth(0.5).strokeColor("#e2e8f0").stroke();
    const cw = [129, 129, 129, 128];
    [
      ["SHIFT DATE", rangeWords(r)],
      ["SHIFT DAY", "00:00 to 24:00 IST"],
      ["SECTION", r.filterLabels.machine === "All" ? "Sewing — all machines" : r.filterLabels.machine],
      ["REPORT NO.", reportNo],
      ["OPERATORS INCLUDED", r.filterLabels.operator],
      ["STYLE INCLUDED", r.filterLabels.product],
      ["DAYS WITH PRODUCTION", `${r.totals.datesWithData} of ${r.range.days}`],
      ["PRINTED", istStamp(r.generatedAt)],
    ].forEach(([label, value], i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const cx = PDF_MARGIN + cw.slice(0, col).reduce((a, b) => a + b, 0);
      const cy = gridY + row * 30;
      if (row === 0 && col > 0) {
        doc.moveTo(cx, gridY).lineTo(cx, gridY + 60).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
      }
      doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
        .text(label, cx + 6, cy + 5, { width: cw[col] - 12, lineBreak: false, ellipsis: true });
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a")
        .text(String(value), cx + 6, cy + 16, { width: cw[col] - 12, lineBreak: false, ellipsis: true });
    });
    doc.y = gridY + 66;
    prose("From the machines on the floor. Times are IST.", { gap: 0.4 });

    // ── 2 · What this report says ────────────────────────────────────────────
    const T = r.totals;
    const eff = T.pacePercent;
    heading("What this report says", 12);

    const verdict = [];
    if (T.pieces === 0) {
      verdict.push("No production was recorded in this period.");
    } else {
      verdict.push(
        eff == null
          ? `${T.pieces} garments were finished. Efficiency could not be measured: no operation has a standard time against this work, so there is nothing to compare it with.`
          : `${T.pieces} garments at ${eff}% efficiency — ${durationWords(T.paceSamSeconds)} of standard time in ${durationWords(T.paceActualSeconds)}.`
      );
      if (T.paceBatchScanning) {
        verdict.push("Tickets were entered in batches, so these times show when they were entered.");
      }
    }
    verdict.forEach((v) => prose(v, { font: "Helvetica-Bold", size: 9.5, color: "#0f172a", gap: 0.15 }));
    doc.moveDown(0.3);

    /* FOUR FIGURES, THE SAME FOUR THE DASHBOARD LEADS WITH.
       Repeat scans, sign-ins and standard time had a card each. Repeats and
       standard time are already said elsewhere — repeats under Garments, where
       they explain the difference between it and the scan count, and standard
       time in the formula line two inches below, where it is one of the two
       operands. Sign-ins is a floor-discipline figure, not a production one,
       and it stays on the operator table where it belongs to a person. */
    const tiles = [
      ["GARMENTS", String(T.pieces), "finished pieces"],
      ["OPERATORS", String(T.operators), "people who worked"],
      ["MACHINES USED", String(T.machines), "machines that finished a garment"],
      [
        "EFFICIENCY",
        eff == null ? "Not measured" : `${eff}%`,
        "whole floor, everyone together",
      ],
    ];
    let cx = PDF_MARGIN;
    let cy = doc.y;
    tiles.forEach((t, i) => {
      doc.roundedRect(cx + 2, cy, 124, 44, 3).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
      doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
        .text(t[0], cx + 8, cy + 5, { width: 114, lineBreak: false, ellipsis: true });
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
        .text(t[1], cx + 8, cy + 15, { width: 114, lineBreak: false, ellipsis: true });
      doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
        .text(t[2], cx + 8, cy + 33, { width: 114, lineBreak: false, ellipsis: true });
      cx += 128.75;
    });
    doc.x = PDF_MARGIN;
    doc.y = cy + 56;

    /* ONE LINE, NOT FOUR. The formula, this report's own numbers, and what the
       result means. Everything else was a lecture a manager skips. */
    prose(
      "Efficiency = standard time (SAM) ÷ time between finished garments × 100" +
      (eff == null
        ? ". 100% = took exactly the standard time."
        : `. Here ${Math.round(T.paceSamSeconds)}s ÷ ${Math.round(T.paceActualSeconds)}s = ${eff}%. 100% = took exactly the standard time.`),
      { size: 7.5, gap: 0.4 }
    );

    // ── 3 · Day by day (period reports only) ─────────────────────────────────
    if (r.range.days > 1) {
      heading("Day by day", 12);
      const dayW = [85, 80, 115, 115, 120];
      const al = ["left", "right", "right", "right", "right"];
      const dayHead = () =>
        tableRow(["Date", "Garments", "Standard", "Took", "Efficiency"],
          dayW, { bold: true, size: 8, color: "#334155", rule: true, align: al });
      dayHead();
      for (const d of r.days) {
        tableRow([
          d.dayKey,
          d.totals.pieces,
          d.pace?.totalActualSeconds > 0 ? durationWords(d.pace.totalSamSeconds) : "—",
          d.pace?.totalActualSeconds > 0 ? durationWords(d.pace.totalActualSeconds) : "—",
          d.pace?.pacePercent == null ? "Not measured" : `${d.pace.pacePercent}%`,
        ], dayW, { align: al, repeatHeader: dayHead });
      }
      tableRow([
        "TOTAL", T.pieces,
        T.paceIntervals > 0 ? durationWords(T.paceSamSeconds) : "—",
        T.paceIntervals > 0 ? durationWords(T.paceActualSeconds) : "—",
        eff == null ? "Not measured" : `${eff}%`,
      ], dayW, { bold: true, align: al, rule: true });
    }

    // ── 4 · Operator by operator ─────────────────────────────────────────────
    /* The spine of the answer to the complaint: scans, repeats, garments,
       machines and sign-ins on one line for every person, with the machines
       named underneath. */
    heading("Operator by operator", 12);


    const ops = mergeDays(
      (d) => d.operators,
      (o) => o.operatorId,
      (o) => ({
        operatorId: o.operatorId, operatorName: o.operatorName,
        scans: 0, repeatScans: 0, garments: 0, sessions: 0, outside: 0,
        sam: 0, actual: 0, machines: new Map(),
      }),
      (a, o) => {
        a.operatorName = a.operatorName || o.operatorName;
        a.scans += o.scans || 0;
        a.repeatScans += o.repeatScans || 0;
        a.garments += o.garments || 0;
        a.sessions += (o.sessions || []).length;
        a.outside += o.scansOutsideSession || 0;
        a.sam += o.paceSamSeconds || 0;
        a.actual += o.paceActualSeconds || 0;
        for (const m of o.machinesDetail || []) {
          const cur = a.machines.get(m.machineId) || { machineName: m.machineName, scans: 0, pieces: 0 };
          cur.scans += m.scans;
          cur.pieces += m.pieces;
          a.machines.set(m.machineId, cur);
        }
      }
    ).sort((a, b) => b.garments - a.garments);

    /* No "Machines" count column: the machines are named in full on the line
       directly below each row, and the count was costing the two time columns
       the width they need to print "53 min 37 sec" without wrapping. */
    const opW = [130, 60, 60, 85, 85, 95];
    const opAl = ["left", "left", "right", "right", "right", "right"];
    const opHead = () =>
      tableRow(["Operator", "ID card", "Garments", "Standard", "Took", "Efficiency"], opW,
        { bold: true, size: 8, color: "#334155", rule: true, align: opAl });
    opHead();
    if (!ops.length) {
      tableRow(["No operator worked in this period", "", "", "", "", ""], opW, { color: "#94a3b8" });
    }
    for (const o of ops) {
      tableRow([
        o.operatorName || o.operatorId, o.operatorId, o.garments,
        o.actual > 0 ? durationWords(o.sam) : "—",
        o.actual > 0 ? durationWords(o.actual) : "—",
        pctText(o.sam, o.actual),
      ], opW, { align: opAl, repeatHeader: opHead });

      const mline = [...o.machines.values()]
        .sort((a, b) => b.pieces - a.pieces)
        .map((m) => `${m.machineName} — ${m.pieces} garment${m.pieces === 1 ? "" : "s"}`)
        .join(" · ");
      prose(`Machines: ${mline || "none recorded"}`, { size: 7, indent: 8, gap: 0.15 });

      if (o.sessions === 0 && o.garments > 0) {
        prose("never badged in", { font: "Helvetica-Oblique", size: 7, color: "#b45309", indent: 8, gap: 0.2 });
      }
    }


    // ── 5 · Machine by machine ───────────────────────────────────────────────
    heading("Machine by machine", 12);
    prose("Worst efficiency first — this is the walking order for the floor.", { size: 7.5, gap: 0.3 });

    const opsByMachine = new Map();
    for (const d of r.days) {
      for (const o of d.operators || []) {
        for (const md of o.machinesDetail || []) {
          const k = String(md.machineId);
          if (!opsByMachine.has(k)) opsByMachine.set(k, new Set());
          opsByMachine.get(k).add(o.operatorName || o.operatorId);
        }
      }
    }

    const macs = mergeDays(
      (d) => d.machines,
      (m) => m.machineId,
      (m) => ({
        machineName: m.machineName, machineType: m.machineType,
        garments: 0, scanEvents: 0, sam: 0, actual: 0, intervals: 0, operators: new Set(),
      }),
      (a, m) => {
        a.garments += m.garments || 0;
        a.scanEvents += m.scanEvents || 0;
        a.sam += m.paceSamSeconds || 0;
        a.actual += m.paceActualSeconds || 0;
        a.intervals += m.paceIntervals || 0;
        for (const n of String(m.operators || "").split(",")) {
          const v = n.trim();
          if (v) a.operators.add(v);
        }
        /* machines[].operators comes from the rollup's operatorSpans, which is
           empty for shifts written before that field existed. The operator rows
           always know which machines they touched, so they are the fallback. */
        for (const o of opsByMachine.get(String(m.machineId)) || []) a.operators.add(o);
      }
    ).sort((a, b) => {
      const am = a.actual > 0, bm = b.actual > 0;
      if (am !== bm) return am ? -1 : 1;
      if (am) return a.sam / a.actual - b.sam / b.actual;
      return b.garments - a.garments;
    });

    const mW = [115, 60, 55, 80, 80, 60, 65];
    const mAl = ["left", "left", "right", "right", "right", "right", "right"];
    const mHead = () =>
      tableRow(["Machine", "Type", "Garments", "Standard time", "Time taken", "Per garment", "Efficiency"],
        mW, { bold: true, size: 8, color: "#334155", rule: true, align: mAl });
    mHead();
    if (!macs.length) {
      tableRow(["No machine worked in this period", "", "", "", "", "", ""], mW, { color: "#94a3b8" });
    }
    for (const m of macs) {
      tableRow([
        m.machineName, m.machineType || "—", m.garments,
        m.actual > 0 ? durationWords(m.sam) : "—",
        m.actual > 0 ? durationWords(m.actual) : "—",
        m.intervals > 0 ? durationWords(m.actual / m.intervals) : "—",
        pctText(m.sam, m.actual),
      ], mW, { align: mAl, repeatHeader: mHead });
      prose(`Operators: ${[...m.operators].join(", ") || "none recorded"}`,
        { size: 7, indent: 8, gap: 0.15 });
    }
    if (macs.length) {
      tableRow([
        "Floor total", "", T.pieces,
        T.paceIntervals > 0 ? durationWords(T.paceSamSeconds) : "—",
        T.paceIntervals > 0 ? durationWords(T.paceActualSeconds) : "—",
        T.paceIntervals > 0 ? durationWords(T.paceActualSeconds / T.paceIntervals) : "—",
        eff == null ? "Not measured" : `${eff}%`,
      ], mW, { bold: true, align: mAl, rule: true });

    }

    const allOps = mergeDays(
      (d) => d.pace?.byOperation,
      (o) => o.operationCode,
      (o) => ({
        operationCode: o.operationCode, samSeconds: o.samSeconds, scansConsidered: 0,
        intervals: 0, sam: 0, actual: 0, measurable: o.measurable, reason: o.reason, caveat: o.caveat,
      }),
      (a, o) => {
        a.scansConsidered += o.scansConsidered || 0;
        a.intervals += o.intervals || 0;
        a.sam += o.totalSamSeconds || 0;
        a.actual += o.totalActualSeconds || 0;
        if (o.measurable === false) a.reason = a.reason || o.reason;
        a.caveat = a.caveat || o.caveat;
      }
    );

    // ── 6 · Operation against standard time ──────────────────────────────────
    heading("Operation against standard time", 12);
    prose("Where the standard minutes were lost. Worst first.", { size: 7.5, gap: 0.3 });

    const oW = [160, 60, 80, 80, 70, 65];
    const oAl = ["left", "right", "right", "right", "right", "right"];
    const oHead = () =>
      tableRow(["Operation", "SAM each", "Standard time", "Time taken", "Per garment", "Efficiency"],
        oW, { bold: true, size: 8, color: "#334155", rule: true, align: oAl });
    oHead();
    const shown = allOps.filter((o) => o.scansConsidered > 0).sort((a, b) => {
      const am = a.actual > 0, bm = b.actual > 0;
      if (am !== bm) return am ? -1 : 1;
      if (am) return a.sam / a.actual - b.sam / b.actual;
      return 0;
    });
    if (!shown.length) {
      tableRow(["Nothing could be measured against standard time in this period", "", "", "", "", ""],
        oW, { color: "#94a3b8" });
    }
    for (const o of shown) {
      tableRow([
        opLabel(o.operationCode), durationWords(o.samSeconds),
        o.actual > 0 ? durationWords(o.sam) : "—",
        o.actual > 0 ? durationWords(o.actual) : "—",
        o.intervals > 0 ? durationWords(o.actual / o.intervals) : "—",
        pctText(o.sam, o.actual),
      ], oW, { align: oAl, color: o.actual > 0 ? "#0f172a" : "#94a3b8", repeatHeader: oHead });
      /* Only the reason an operation could not be measured. The batch-scanning
         caveat is the same finding as the sentence at the top of page 1, in
         three times the words, and it is the one place the report still spoke
         of gaps and scans. Said once, up there. */
      if (o.reason) {
        prose(o.reason, { font: "Helvetica-Oblique", size: 7, color: "#b45309", indent: 8, gap: 0.2 });
      }
    }
    prose("A garment can finish two operations at once, so these add up to more than the floor total.",
      { size: 7, gap: 0.3 });

    // ── 7 · Orders: what is made and what is still owed ─────────────────────
    /* THE QUESTION A MANAGER ASKS THAT A PIECE COUNT CANNOT ANSWER.
       "9 garments" says how busy the floor was. "9 of 80, 71 still to make"
       says whether the order ships. The ordered quantity and the order's own
       status come off the work order; the done figure is counted from this
       period's scans, so it is THIS PERIOD's output against the whole order —
       stated in the note below rather than left to be assumed. */
    heading("Orders — made and still to make", 12);
    prose("Made = finished in these dates. Still to make = ordered less everything done so far.",
      { size: 7.5, gap: 0.3 });

    /* buildReport already merged these across the period, deduplicating the
       garments — summing the days here would count a garment scanned on two of
       them twice. See the workOrders rollup in reportBuilder. */
    const orders = r.workOrders || [];

    /* THE GARMENT, NOT JUST ITS NAME. A supervisor recognises the trouser
       before they read the order number, and the dashboard already shows it.
       Fetched at render time because the image lives on Cloudinary, so:
       - asked for at 120px wide and as JPEG via a Cloudinary transform, which
         is what pdfkit embeds directly and keeps the file small;
       - all of them in parallel, behind one 4s budget;
       - a failure is a missing picture, never a missing report. */
    const thumbs = new Map();
    {
      const wanted = orders.filter((o) => o.productImage).slice(0, 40);
      if (wanted.length) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        await Promise.all(
          wanted.map(async (o) => {
            try {
              const url = String(o.productImage).replace(
                "/image/upload/",
                "/image/upload/w_120,c_limit,f_jpg,q_auto/"
              );
              const resp = await fetch(url, { signal: ctrl.signal });
              if (!resp.ok) return;
              const buf = Buffer.from(await resp.arrayBuffer());
              /* pdfkit accepts JPEG and PNG only, and throws on anything else —
                 which would abort the whole document for a thumbnail. */
              const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
              const png = buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
              if (jpeg || png) thumbs.set(o.workOrderKey, buf);
            } catch {
              /* no picture for this one */
            }
          })
        );
        clearTimeout(timer);
      }
    }

    const ordW = [78, 140, 88, 46, 40, 58, 65];
    const ordAl = ["left", "left", "left", "right", "right", "right", "left"];
    const ordHead = () =>
      tableRow(["Order", "Garment", "Customer", "Ordered", "Made", "Still to make", "Status"],
        ordW, { bold: true, size: 8, color: "#334155", rule: true, align: ordAl });
    ordHead();
    if (!orders.length) {
      tableRow(["No order was worked on in this period", "", "", "", "", "", ""], ordW, { color: "#94a3b8" });
    }
    let totalOrdered = 0;
    let totalDone = 0;
    let totalLeft = 0;
    for (const o of orders) {
      const left = o.orderQuantity != null ? Math.max(0, o.orderQuantity - o.done) : null;
      const over = o.orderQuantity != null ? Math.max(0, o.done - o.orderQuantity) : 0;
      if (o.orderQuantity != null) totalOrdered += o.orderQuantity;
      totalDone += o.done;
      if (left != null) totalLeft += left;
      tableRow([
        o.moNumber || "No order number",
        [o.productName, o.variant].filter(Boolean).join(" · "),
        o.customerName || "—",
        o.orderQuantity ?? "not on file",
        o.done,
        left == null ? "—" : left,
        /* MORE MADE THAN ORDERED IS A FINDING, NOT A ROUNDING ERROR. `remaining`
           floors at zero so a manager is never told to make a negative number,
           and that floor would quietly hide the overrun — so the overrun is
           named here instead. 29 garments against an order of 20 is rework,
           double-scanning, or an order quantity nobody updated; all three are
           worth a question. */
        over > 0 ? `Over by ${over}` : left === 0 ? "Complete" : o.workOrderStatus || "—",
      ], ordW, {
        align: ordAl,
        color: over > 0 ? "#b45309" : left === 0 ? "#166534" : "#0f172a",
        repeatHeader: ordHead,
      });
      const madeOn =
        `${o.done} garment${o.done === 1 ? "" : "s"}` +
        (o.machines ? ` on ${o.machines}` : "") +
        (o.operators ? ` by ${o.operators}` : "");
      const thumb = thumbs.get(o.workOrderKey);
      if (thumb) {
        /* Reserve the row before drawing: an image is placed at an absolute
           position and does not move doc.y, so without this it can straddle a
           page break with its caption on the other side. */
        ensureRoom(30, ordHead);
        const ty = doc.y;
        try {
          doc.image(thumb, PDF_MARGIN + 8, ty, { fit: [26, 26] });
        } catch {
          /* a corrupt image is not a reason to lose the order row */
        }
        doc.y = ty + 2;
        prose(madeOn, { size: 7, indent: 40, gap: 0.15 });
        if (doc.y < ty + 28) doc.y = ty + 28;
      } else {
        prose(madeOn, { size: 7, indent: 8, gap: 0.15 });
      }
    }
    if (orders.length > 1) {
      tableRow(
        ["TOTAL", "", "", totalOrdered || "—", totalDone, totalLeft || "—", ""],
        ordW,
        { bold: true, align: ordAl, rule: true }
      );
    }

    // ── 8 · Sign-off ────────────────────────────────────────────────────────
    ensureRoom(70);
    doc.moveDown(1);
    const sy = doc.y;
    const sw = [171, 172, 172];
    ["Prepared by (IE)", "Checked by (Production Manager)", "Date"].forEach((label, i) => {
      const x = PDF_MARGIN + sw.slice(0, i).reduce((a, b) => a + b, 0);
      doc.moveTo(x + 4, sy + 26).lineTo(x + sw[i] - 12, sy + 26)
        .lineWidth(0.5).strokeColor("#94a3b8").stroke();
      doc.font("Helvetica").fontSize(7).fillColor("#64748b")
        .text(label, x + 4, sy + 30, { width: sw[i] - 16, lineBreak: false });
    });
    doc.y = sy + 44;

    // ── Page numbers, once the count is known ────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.font("Helvetica").fontSize(7).fillColor("#94a3b8").text(
        `${reportNo} · GRAV Production Report · ${rangeWords(r)} · page ${i + 1} of ${pages.count}`,
        PDF_MARGIN,
        doc.page.height - PDF_MARGIN + 6,
        { width: W, align: "center", lineBreak: false }
      );
    }

    doc.end();
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      return res
        .status(500)
        .json({ success: false, message: "pdfkit not installed. Run: npm install pdfkit" });
    }
    fail(res, error, "pdf");
  }
});

module.exports = router;
