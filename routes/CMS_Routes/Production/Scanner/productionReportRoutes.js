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

/* One sentence, shared by every format, saying what the denominator contains.
   It stopped being "time spent working" on 2026-09-15 when the idle-gap
   threshold was removed, and a percentage that does not say so invites exactly
   the misreading the change was meant to avoid. */
const BASIS_TEXT =
  "Elapsed time between garments, including waiting, thread breaks and unrecorded absence. " +
  "This is output per hour present, not working speed.";

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
  ["Total scans", o.scansConsidered],
  ["Valid intervals", o.intervals],
  ["Total SAM time", clock(o.totalSamSeconds)],
  ["Total actual time", clock(o.totalActualSeconds)],
  ["Average actual time", clock(o.averageActualSeconds)],
  ["Overall efficiency", o.pacePercent == null ? `N/A — ${o.reason || "insufficient data"}` : `${o.pacePercent}%`],
  /* Since 2026-09-15 no gap is discarded as a stop, so the denominator is
     wall-clock time. Saying so next to the number is the whole reason the
     number is safe to publish. */
  ...(o.basis ? [["Basis", o.basis]] : []),
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

router.get("/report/pace-log", async (req, res) => {
  try {
    const day = req.query.day || req.query.date;
    const operation = String(req.query.operation || "").trim();
    const machineId = String(req.query.machineId || "").trim();
    if (!day || (!operation && !machineId)) {
      return res
        .status(400)
        .json({ success: false, message: "day, plus operation or machineId, are required" });
    }

    /* ASKING FOR A MACHINE NARROWS THE SCANS FIRST.
       buildReport's machineId filter applies before pace is computed, so the
       per-operation figures that come back are already this machine's alone.
       That matters: computed across the floor they would mix machines, and a
       gap between two different machines' garments is not a cycle time. */
    const r = await reportBuilder.buildReport({
      ...readOptions(req),
      from: day,
      to: day,
      ...(machineId ? { machineId } : {}),
    });
    const d = (r.days || []).find((x) => x.dayKey === day);
    let ops = (d?.pace?.byOperation || []).filter((o) => o.scansConsidered > 0);
    if (operation) ops = ops.filter((o) => o.operationCode === operation);

    if (ops.length === 0) {
      /* An empty day is the ordinary answer for a floor that did not run, so it
         reads as a sentence rather than an id — the caller shows it verbatim. */
      const who = operation ? `operation ${operation}` : "this device";
      return res
        .status(404)
        .json({ success: false, message: `Nothing was scanned on ${who} on ${day}` });
    }

    const shape = (op) => {
      /* The first scan opens the sequence and closes nothing, so it carries no
         duration and no percentage — the reference §4 describes. It is not in
         `rows` (which holds intervals, not scans), so it is reconstructed from
         the first interval's `previousAt`. */
      const scans = [];
      const first = op.rows?.[0];
      if (first) scans.push({ index: 1, at: first.previousAt, reference: true });
      for (const row of op.rows || []) {
        scans.push({
          index: row.index,
          at: row.at,
          barcodeId: row.barcodeId,
          durationSeconds: row.intervalSeconds,
          counted: row.counted,
          excludedBecause: row.excludedBecause,
          /* Per-interval, for THIS ROW ONLY. Never summed anywhere: §7 forbids
             averaging this column, and the overall below is a ratio of totals. */
          efficiencyPercent:
            row.counted && row.intervalSeconds > 0
              ? Math.round((op.samSeconds / row.intervalSeconds) * 10000) / 100
              : null,
        });
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
      operations: ops.map(shape),
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
    const r = await reportBuilder.buildReport(readOptions(req));
    res.json({
      success: true,
      generatedAt: r.generatedAt,
      range: r.range,
      filters: r.filters,
      filterLabels: r.filterLabels,
      totals: r.totals,
      days: r.days.map((d) => ({
        dayKey: d.dayKey,
        hasData: d.hasData,
        totals: d.totals,
        products: d.products,
        operators: d.operators,
        machines: d.machines,
        scanRowCount: d.scanRows.length,
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
        widths: [13, 14, 26, 11, 14, 15, 11, 11, 13, 14, 12, 30, 22],
        headers: [
          "Date", "Operator ID", "Operator", "Garments", "Logged in (min)",
          "Productive (min)", "Idle (min)", "Break (min)", "Earned (min)",
          "Available (min)", "Efficiency %", "Machines", "Operations",
        ],
        rows: (d) =>
          d.operators.map((o) => [
            d.dayKey, o.operatorId, o.operatorName, mins(o.garments), mins(o.minutesLoggedIn),
            mins(o.productiveMinutes), mins(o.idleMinutes), mins(o.breakMinutes),
            mins(o.earnedMinutes), mins(o.availableMinutes), mins(o.efficiencyPercent),
            o.machines, o.operations,
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
      `SAM x intervals / total elapsed time between garments (waiting included) · ${words}`,
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
          "Interval", "Counted", "Excluded because", "Barcode",
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

router.get("/report/pdf", async (req, res) => {
  try {
    const PDFDocument = require("pdfkit");
    const r = await reportBuilder.buildReport(readOptions(req));

    const doc = new PDFDocument({ size: "A4", margin: PDF_MARGIN, bufferPages: true });
    const file = r.range.from === r.range.to ? r.range.from : `${r.range.from}_to_${r.range.to}`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=grav-production-${file}.pdf`);
    doc.pipe(res);

    const W = doc.page.width - PDF_MARGIN * 2;
    const BOTTOM = doc.page.height - PDF_MARGIN - 24;

    /* Every table draws through this, so a long report breaks across pages
       instead of running off the bottom — the failure a raw table dump always
       has. The header is re-printed on each new page, because a column of
       numbers with no heading is unreadable two pages in. */
    const ensureRoom = (need, repeatHeader) => {
      if (doc.y + need <= BOTTOM) return;
      doc.addPage();
      if (repeatHeader) repeatHeader();
    };

    const heading = (text, size = 12) => {
      ensureRoom(34);
      doc.moveDown(0.6);
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(size).text(text);
      doc.moveDown(0.25);
    };

    const tableRow = (cells, widths, opts = {}) => {
      const size = opts.size || 8.5;
      doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
        .fillColor(opts.color || "#0f172a");
      const y = doc.y;
      let x = PDF_MARGIN;
      cells.forEach((c, i) => {
        doc.text(String(c == null ? "" : c), x + 2, y, {
          width: widths[i] - 4,
          align: opts.align && opts.align[i] ? opts.align[i] : "left",
          lineBreak: false,
          ellipsis: true,
        });
        x += widths[i];
      });
      doc.y = y + size + 4;
      if (opts.rule) {
        doc.moveTo(PDF_MARGIN, doc.y - 2)
          .lineTo(PDF_MARGIN + W, doc.y - 2)
          .lineWidth(0.5)
          .strokeColor("#cbd5e1")
          .stroke();
      }
    };

    // ── Cover block ──────────────────────────────────────────────────────────
    doc.rect(PDF_MARGIN, PDF_MARGIN, W, 54).fill("#1f2937");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(17)
      .text("GRAV Production Report", PDF_MARGIN + 12, PDF_MARGIN + 12);
    doc.font("Helvetica").fontSize(9.5).fillColor("#cbd5e1")
      .text(rangeWords(r), PDF_MARGIN + 12, PDF_MARGIN + 34);
    doc.y = PDF_MARGIN + 66;
    doc.fillColor("#475569").font("Helvetica").fontSize(9);
    doc.text(filterWords(r), PDF_MARGIN, doc.y);
    doc.text(metaLine(r), PDF_MARGIN, doc.y);

    // ── KPIs ─────────────────────────────────────────────────────────────────
    heading("Overview");
    const kpis = [
      ["Garments", r.totals.pieces],
      ["Scans", r.totals.scanEvents],
      ["Repeat scans", r.totals.repeatScans],
      ["Operators", r.totals.operators],
      ["Machines", r.totals.machines],
      ["Products", r.totals.products],
      ["Worked (min)", r.totals.workedMinutes == null ? "—" : r.totals.workedMinutes],
      ["Break (min)", r.totals.breakMinutes == null ? "—" : r.totals.breakMinutes],
      ["Idle (min)", r.totals.idleMinutes == null ? "—" : r.totals.idleMinutes],
      ["Days with data", `${r.totals.datesWithData}/${r.range.days}`],
    ];
    const cardW = W / 5;
    let cx = PDF_MARGIN;
    let cy = doc.y;
    kpis.forEach((k, i) => {
      if (i === 5) {
        cy += 44;
        cx = PDF_MARGIN;
      }
      doc.roundedRect(cx + 2, cy, cardW - 6, 38, 3)
        .lineWidth(0.5).strokeColor("#e2e8f0").stroke();
      doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
        .text(String(k[0]).toUpperCase(), cx + 7, cy + 6, {
          width: cardW - 16, lineBreak: false, ellipsis: true,
        });
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
        .text(String(k[1]), cx + 7, cy + 17, { width: cardW - 16, lineBreak: false });
      cx += cardW;
    });
    doc.y = cy + 52;

    // ── Date-wise breakdown ──────────────────────────────────────────────────
    const dayW = [64, 58, 48, 52, 58, 56, 58, 50];
    const dayHead = () =>
      tableRow(
        ["Date", "Garments", "Scans", "Repeats", "Operators", "Machines", "Worked", "Break"],
        dayW,
        { bold: true, size: 8, color: "#334155", rule: true }
      );
    heading("Date-wise breakdown");
    dayHead();
    for (const d of r.days) {
      ensureRoom(16, dayHead);
      tableRow(
        [
          d.dayKey,
          d.hasData ? d.totals.pieces : "—",
          d.hasData ? d.totals.scanEvents : "—",
          d.hasData ? d.totals.repeatScans : "—",
          d.hasData ? d.totals.operators : "—",
          d.hasData ? d.totals.machines : "—",
          d.totals.workedMinutes == null ? "—" : d.totals.workedMinutes,
          d.totals.breakMinutes == null ? "—" : d.totals.breakMinutes,
        ],
        dayW,
        { color: d.hasData ? "#0f172a" : "#94a3b8" }
      );
    }
    ensureRoom(18, dayHead);
    tableRow(
      [
        "TOTAL", r.totals.pieces, r.totals.scanEvents, r.totals.repeatScans,
        r.totals.operators, r.totals.machines,
        r.totals.workedMinutes == null ? "—" : r.totals.workedMinutes,
        r.totals.breakMinutes == null ? "—" : r.totals.breakMinutes,
      ],
      dayW,
      { bold: true, rule: true }
    );

    // ── Products, operators, machines — aggregated over the whole period ─────
    const agg = (rowsOf, keyOf) => {
      const m = new Map();
      for (const d of r.days) {
        for (const row of rowsOf(d)) {
          const k = keyOf(row);
          if (!k) continue;
          if (!m.has(k)) m.set(k, { label: k, garments: 0, extra: row });
          m.get(k).garments += row.garments || 0;
        }
      }
      return [...m.values()].sort((a, b) => b.garments - a.garments);
    };

    const sections = [
      {
        title: "Products",
        rows: agg((d) => d.products, (p) => p.productName),
        cols: ["Product", "Garments", "Product code", "Customer"],
        widths: [190, 60, 130, 135],
        cell: (v) => [v.label, v.garments, v.extra.productCode || "", v.extra.customerName || ""],
      },
      {
        title: "Operators",
        rows: agg((d) => d.operators, (o) => o.operatorName || o.operatorId),
        cols: ["Operator", "Garments", "Operator ID", "Machines"],
        widths: [170, 60, 90, 195],
        cell: (v) => [v.label, v.garments, v.extra.operatorId || "", v.extra.machines || ""],
      },
      {
        title: "Machines",
        rows: agg((d) => d.machines, (m) => m.machineName),
        cols: ["Machine", "Garments", "Type", "Operators"],
        widths: [160, 60, 90, 205],
        cell: (v) => [v.label, v.garments, v.extra.machineType || "", v.extra.operators || ""],
      },
    ];

    for (const s of sections) {
      const head = () =>
        tableRow(s.cols, s.widths, { bold: true, size: 8, color: "#334155", rule: true });
      heading(s.title);
      head();
      if (s.rows.length === 0) {
        tableRow(["No data available for this period", "", "", ""], s.widths, {
          color: "#94a3b8",
        });
        continue;
      }
      for (const v of s.rows) {
        ensureRoom(16, head);
        tableRow(s.cell(v), s.widths);
      }
    }

    // ── Efficiency against standard time (§14) ───────────────────────────────
    const effW = [70, 52, 58, 68, 70, 74, 62, 60];
    const effHead = () =>
      tableRow(
        ["Operation", "SAM", "Scans", "Intervals", "Total SAM", "Total actual", "Average", "Efficiency"],
        effW,
        { bold: true, size: 8, color: "#334155", rule: true }
      );
    heading("Work produced against standard time");
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text(
        "SAM x intervals / total elapsed time between garments. The first scan of a sequence is a " +
          "reference only and contributes no interval. " + BASIS_TEXT,
        { width: W }
      );
    doc.moveDown(0.3);
    const pdfConflict = samConflictLine(r);
    if (pdfConflict) {
      doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#b45309")
        .text(pdfConflict, { width: W });
      doc.moveDown(0.3);
    }
    effHead();
    let anyPace = false;
    for (const d of r.days) {
      for (const o of d.pace?.byOperation || []) {
        if (!o.scansConsidered) continue;
        anyPace = true;
        ensureRoom(16, effHead);
        tableRow(
          [
            `${d.dayKey.slice(5)} ${o.operationCode}`,
            clock(o.samSeconds),
            o.scansConsidered,
            o.intervals,
            clock(o.totalSamSeconds),
            clock(o.totalActualSeconds),
            clock(o.averageActualSeconds),
            o.pacePercent == null ? "N/A" : `${o.pacePercent}%`,
          ],
          effW,
          { color: o.pacePercent == null ? "#94a3b8" : "#0f172a" }
        );
        if (o.caveat) {
          ensureRoom(22, effHead);
          doc.font("Helvetica-Oblique").fontSize(7).fillColor("#b45309")
            .text(o.caveat, PDF_MARGIN + 8, doc.y, { width: W - 16 });
          doc.moveDown(0.2);
        }
      }
    }
    if (!anyPace) {
      tableRow(["No scans to measure against SAM in this period", "", "", "", "", "", "", ""], effW, {
        color: "#94a3b8",
      });
    }

    /* Page numbers last, once the count is known — the reason the document was
       opened with bufferPages. */
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.font("Helvetica").fontSize(7.5).fillColor("#94a3b8").text(
        `GRAV Production Report · ${rangeWords(r)} · page ${i + 1} of ${pages.count}`,
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
