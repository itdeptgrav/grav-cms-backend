// routes/CMS_Routes/Production/Scanner/productionReportRoutes.js
//
// DATE-WISE PRODUCTION REPORT, AS A WORKBOOK.
//
// The Floor Summary answers "how is today going". This answers "what happened
// over these dates", which is a different job: it has to be openable in Excel,
// filterable, and detailed enough to settle an argument — so it carries the
// transaction-level scan rows, not only the totals.
//
// ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────
// Nothing here recalculates production. Every figure is either
//   · read from the rollup's own read models (MachineDayStats, OperatorDayStats)
//     — the same documents the dashboards render, so the report cannot disagree
//     with the screen it was downloaded from; or
//   · counted from ProductionEvent with countDistinctPieces(), the one shared
//     definition of a garment (barcode + sorted operation set).
// There is no third opinion in this file, and no mock data anywhere in it.
//
// ── A DAY WITH NO DATA IS A ROW, NOT A GAP ───────────────────────────────────
// A date nobody worked still appears, saying so. Silently omitting it would let
// a reader assume the export was truncated, and "the floor was shut" is itself
// a finding.
//
// ── SHIFT DATES, NOT CALENDAR DATES ──────────────────────────────────────────
// Every date is resolved through shiftDateFor(), the same IST bucketing the
// scanners and the rollup use. A scan at 00:30 IST belongs to the shift that
// opened the previous evening, and this report must agree with the floor about
// which day that was.

"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const B = "../../../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const MachineDayStats = require(`${B}/MachineDayStats`);
const OperatorDayStats = require(`${B}/OperatorDayStats`);

const S = "../../../../services/barcodeScanner";
const { shiftDateFor, currentShiftDate } = require(`${S}/shift`);
const masterData = require(`${S}/masterData`);
const { countDistinctPieces, pieceKeyOf } = require(`${S}/rollupStats`);

/* Same auth as every other production surface: an authenticated employee. The
   router carries it itself rather than relying on the mount, the way the
   scanner routers do — moving the mount cannot quietly open it. */
router.use(EmployeeAuthMiddleware);

// ─── Dates ────────────────────────────────────────────────────────────────────

/** Widest range a single request may ask for. */
const MAX_DAYS = 92;

const IST_OFFSET_MIN = 330;

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

function parseDayKey(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

// ─── Gathering ────────────────────────────────────────────────────────────────

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Everything the workbook needs for ONE shift date.
 *
 * Returns `hasData: false` for a day nobody worked — the caller still writes a
 * row for it, because an empty day is information.
 */
async function gatherDay(shiftDate, master) {
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

// ─── Workbook ─────────────────────────────────────────────────────────────────

const TITLE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };

/** A sheet's header block: report title, what it covers, when it was made. */
function writeSheetHead(ws, title, subtitle, meta) {
  ws.mergeCells("A1:D1");
  const t = ws.getCell("A1");
  t.value = title;
  t.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
  t.fill = TITLE_FILL;
  t.alignment = { vertical: "middle" };
  ws.getRow(1).height = 22;

  ws.getCell("A2").value = subtitle;
  ws.getCell("A2").font = { size: 10, color: { argb: "FF475569" } };
  ws.getCell("A3").value = meta;
  ws.getCell("A3").font = { size: 9, color: { argb: "FF94A3B8" } };
}

/** Header row with the house styling, at `rowNumber`. */
function writeHeaderRow(ws, rowNumber, headers) {
  const row = ws.getRow(rowNumber);
  headers.forEach((h, i) => {
    const c = row.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 10 };
    c.fill = HEAD_FILL;
    c.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });
  row.commit?.();
  ws.views = [{ state: "frozen", ySplit: rowNumber }];
}

const mins = (v) => (v == null ? "" : v);

// ─── GET /report/xlsx?from=YYYY-MM-DD&to=YYYY-MM-DD ───────────────────────────
router.get("/report/xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");

    const fromRaw = req.query.from || req.query.date;
    const toRaw = req.query.to || req.query.date || fromRaw;
    const from = parseDayKey(fromRaw) || parseDayKey(dayKeyOf(currentShiftDate()));
    const to = parseDayKey(toRaw) || from;
    if (!from || !to) {
      return res
        .status(400)
        .json({ success: false, message: "Use from=YYYY-MM-DD and to=YYYY-MM-DD." });
    }

    const ordered =
      new Date(Date.UTC(from.y, from.m - 1, from.d)) <=
      new Date(Date.UTC(to.y, to.m - 1, to.d))
        ? { a: from, b: to }
        : { a: to, b: from }; // a reversed range is a typo, not an error

    const dates = shiftDatesBetween(ordered.a, ordered.b);
    if (dates.length > MAX_DAYS) {
      return res.status(400).json({
        success: false,
        message: `That range is ${dates.length} days. Ask for ${MAX_DAYS} or fewer.`,
      });
    }

    const master = await masterData.getMasterData();
    const days = [];
    for (const d of dates) days.push(await gatherDay(d, master));

    const generatedAt = new Date();
    const rangeWords =
      days.length === 1
        ? days[0].dayKey
        : `${days[0].dayKey} to ${days[days.length - 1].dayKey}`;
    const meta = `Generated ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · GRAV Production`;

    const wb = new ExcelJS.Workbook();
    wb.creator = "GRAV Production";
    wb.created = generatedAt;

    // ── 1. Summary ────────────────────────────────────────────────────────────
    const sum = wb.addWorksheet("Summary");
    sum.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 40 }];
    writeSheetHead(sum, "Production Report", `Covering ${rangeWords}`, meta);

    const worked = days.reduce((n, d) => n + (d.totals.workedMinutes || 0), 0);
    const totalRows = [
      ["Dates covered", days.length, "", days.length === 1 ? "single date" : "date range"],
      ["Dates with production", days.filter((d) => d.hasData).length, "", ""],
      ["Garments finished", days.reduce((n, d) => n + d.totals.pieces, 0), "", "distinct pieces; a piece scanned twice counts once"],
      ["Scans recorded", days.reduce((n, d) => n + d.totals.scanEvents, 0), "", "every read the scanner sent"],
      ["Repeat scans", days.reduce((n, d) => n + d.totals.repeatScans, 0), "", "reads of a piece already counted — not production"],
      ["Operators who worked", new Set(days.flatMap((d) => d.operators.map((o) => o.operatorId))).size, "", ""],
      ["Machines used", new Set(days.flatMap((d) => d.machines.map((m) => m.machineId))).size, "", ""],
      ["Time worked (minutes)", round1(worked), "", "attendance from sign-in to sign-out"],
      ["Break time (minutes)", round1(days.reduce((n, d) => n + (d.totals.breakMinutes || 0), 0)), "", ""],
      ["Idle time (minutes)", round1(days.reduce((n, d) => n + (d.totals.idleMinutes || 0), 0)), "", "manned but not scanning"],
    ];
    writeHeaderRow(sum, 5, ["Metric", "Value", "", "Notes"]);
    totalRows.forEach((r, i) => {
      const row = sum.getRow(6 + i);
      row.values = r;
      row.getCell(2).numFmt = "#,##0.#";
      row.getCell(4).font = { size: 9, color: { argb: "FF64748B" } };
    });

    // ── 2. Date-wise Summary ──────────────────────────────────────────────────
    const byDate = wb.addWorksheet("Date-wise Summary");
    byDate.columns = [
      { width: 13 }, { width: 11 }, { width: 11 }, { width: 12 },
      { width: 11 }, { width: 11 }, { width: 10 }, { width: 13 },
      { width: 12 }, { width: 12 }, { width: 30 },
    ];
    writeSheetHead(byDate, "Date-wise Summary", `Covering ${rangeWords}`, meta);
    writeHeaderRow(byDate, 5, [
      "Date", "Garments", "Scans", "Repeats", "Operators", "Machines",
      "Orders", "Worked (min)", "Break (min)", "Idle (min)", "Note",
    ]);
    days.forEach((d, i) => {
      const r = byDate.getRow(6 + i);
      r.values = [
        d.dayKey,
        d.totals.pieces, d.totals.scanEvents, d.totals.repeatScans,
        d.totals.operators, d.totals.machines, d.totals.orders,
        mins(d.totals.workedMinutes), mins(d.totals.breakMinutes), mins(d.totals.idleMinutes),
        d.hasData ? "" : "No data available — nothing was scanned on this date",
      ];
      if (!d.hasData) {
        r.font = { color: { argb: "FF94A3B8" }, italic: true };
      }
    });
    byDate.autoFilter = { from: "A5", to: `K${5 + days.length}` };

    // ── 3-5. Per-entity detail, one block per date ────────────────────────────
    const detailSheets = [
      {
        name: "Product Details",
        widths: [13, 34, 20, 24, 12, 10, 34],
        headers: ["Date", "Product", "Product code", "Customer", "Garments", "Scans", "Work orders"],
        rows: (d) => d.products.map((p) => [
          d.dayKey, p.productName, p.productCode, p.customerName, p.garments, p.scans, p.workOrders,
        ]),
      },
      {
        name: "Operator Details",
        widths: [13, 14, 26, 11, 13, 13, 11, 11, 13, 13, 11, 30, 22],
        headers: [
          "Date", "Operator ID", "Operator", "Garments", "Logged in (min)",
          "Productive (min)", "Idle (min)", "Break (min)", "Earned (min)",
          "Available (min)", "Efficiency %", "Machines", "Operations",
        ],
        rows: (d) => d.operators.map((o) => [
          d.dayKey, o.operatorId, o.operatorName, mins(o.garments), mins(o.minutesLoggedIn),
          mins(o.productiveMinutes), mins(o.idleMinutes), mins(o.breakMinutes),
          mins(o.earnedMinutes), mins(o.availableMinutes), mins(o.efficiencyPercent),
          o.machines, o.operations,
        ]),
      },
      {
        name: "Machine Details",
        widths: [13, 24, 14, 16, 11, 10, 12, 26, 34, 18],
        headers: [
          "Date", "Machine", "Type", "Status", "Garments", "Scans",
          "Rescans dropped", "Operations", "Operators", "Last scan",
        ],
        rows: (d) => d.machines.map((m) => [
          d.dayKey, m.machineName, m.machineType, m.status, mins(m.garments),
          mins(m.scanEvents), mins(m.suppressedRescans), m.operations, m.operators,
          m.lastScanAt ? new Date(m.lastScanAt).toISOString().slice(0, 19).replace("T", " ") : "",
        ]),
      },
    ];

    for (const spec of detailSheets) {
      const ws = wb.addWorksheet(spec.name);
      ws.columns = spec.widths.map((w) => ({ width: w }));
      writeSheetHead(ws, spec.name, `Covering ${rangeWords}`, meta);
      writeHeaderRow(ws, 5, spec.headers);
      let r = 6;
      for (const d of days) {
        const rows = spec.rows(d);
        if (rows.length === 0) {
          const row = ws.getRow(r++);
          row.values = [d.dayKey, "No data available for this date"];
          row.font = { color: { argb: "FF94A3B8" }, italic: true };
          continue;
        }
        for (const v of rows) ws.getRow(r++).values = v;
      }
      ws.autoFilter = { from: "A5", to: `${String.fromCharCode(64 + spec.headers.length)}${r - 1}` };
    }

    // ── 6. Scan / Activity Details — the transaction level ────────────────────
    const act = wb.addWorksheet("Scan Activity");
    act.columns = [
      { width: 20 }, { width: 13 }, { width: 22 }, { width: 8 }, { width: 22 },
      { width: 14 }, { width: 24 }, { width: 16 }, { width: 34 }, { width: 16 },
      { width: 30 }, { width: 20 }, { width: 24 }, { width: 18 }, { width: 14 },
    ];
    writeSheetHead(act, "Scan Activity", `Every scan recorded, ${rangeWords}`, meta);
    writeHeaderRow(act, 5, [
      "Timestamp (UTC)", "Date", "Barcode", "Unit", "Machine", "Operator ID",
      "Operator", "Operation codes", "Operation names", "Work order",
      "Product", "Product code", "Customer", "Counts as production", "Device",
    ]);
    let ar = 6;
    for (const d of days) {
      if (d.scanRows.length === 0) {
        const row = act.getRow(ar++);
        row.values = ["", d.dayKey, "No data available for this date"];
        row.font = { color: { argb: "FF94A3B8" }, italic: true };
        continue;
      }
      for (const s of d.scanRows) {
        const row = act.getRow(ar++);
        row.values = [
          new Date(s.at).toISOString().slice(0, 19).replace("T", " "),
          d.dayKey, s.barcodeId, s.unitNumber, s.machineName, s.operatorId,
          s.operatorName, s.operations, s.operationNames, s.workOrder,
          s.productName, s.productCode, s.customerName, s.countsAsProduction, s.deviceId,
        ];
        // A repeat read is the row a supervisor is usually looking for.
        if (s.countsAsProduction !== "Yes") {
          row.font = { color: { argb: "FFB45309" } };
        }
      }
    }
    act.autoFilter = { from: "A5", to: `O${ar - 1}` };

    const fileRange = days.length === 1 ? days[0].dayKey : `${days[0].dayKey}_to_${days[days.length - 1].dayKey}`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=grav-production-${fileRange}.xlsx`
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      return res
        .status(500)
        .json({ success: false, message: "exceljs not installed. Run: npm install exceljs" });
    }
    console.error("[production-report]", error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
  }
});

module.exports = router;
