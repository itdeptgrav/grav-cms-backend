/**
 * GRAV-CMS-BACKEND/services/accountingExport.service.js
 *
 * Turning an accounting report into a file somebody can open, print and sign.
 *
 * ── WHY THIS IS SEPARATE FROM THE CALCULATION ───────────────────────────────
 * `partyOutstanding.service.js` and its two bindings decide what the numbers
 * ARE. This file decides what they LOOK like. Keeping them apart means the
 * reconciliation tests can prove the figures without building a workbook, and
 * the layout can change without anyone having to re-audit the maths.
 *
 * ── ONE WRITER, EITHER PARTY KIND ───────────────────────────────────────────
 * Every report carries a `labels` block naming its two halves and the party it
 * is about, and the totals carry party-neutral `primaryTotal`/`secondaryTotal`
 * aliases beside their named ones. So the same workbook and the same PDF serve
 * customers and suppliers without either inheriting the other's vocabulary: a
 * supplier sheet says "Payable (Cr)" where the customer sheet says
 * "Receivable (Dr)", from one code path.
 *
 * ── THE TWO RULES THAT MATTER MOST ──────────────────────────────────────────
 * 1. EXCEL AMOUNTS ARE NUMBERS. A cell holding "₹1,23,456.00" is a string:
 *    it will not sum, will not sort, and silently makes every downstream
 *    workbook an accountant builds on top of it wrong. Amount cells here are
 *    written as JavaScript numbers with a `numFmt`, so the rupee sign and the
 *    Indian grouping are display, not data.
 * 2. PDF ROWS DO NOT BREAK AND COLUMNS DO NOT CLIP. Every cell is drawn with
 *    an explicit width, `lineBreak: false` and `ellipsis: true`, so a long
 *    party name is truncated with an ellipsis inside its column instead of
 *    wrapping across the amount beside it. Page breaks are decided BEFORE a
 *    row is drawn, never in the middle of one, and the header band is redrawn
 *    on every page.
 *
 * Both writers stream into the response; nothing is buffered in memory and
 * nothing is written to disk.
 */

"use strict";

/* ────────────────────────────────────────────────────────────────────────── */
/* Shared formatting                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** ExcelJS number format for money. The ₹ is display only — see rule 1. */
const MONEY_FMT = '"₹"#,##0.00';
const INT_FMT = "#,##0";

const INK = "FF1E293B";
const MUTED = "FF64748B";
const BRAND = "FF4F46E5";
const DEBIT = "FFDC2626";
const CREDIT = "FF059669";

const PDF_INK = "#1e293b";
const PDF_MUTED = "#64748b";
const PDF_FAINT = "#94a3b8";
const PDF_BRAND = "#4f46e5";
const PDF_DEBIT = "#dc2626";
const PDF_CREDIT = "#059669";
const PDF_HAIRLINE = "#e2e8f0";
const PDF_BAND = "#f8fafc";

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return `${fmtDate(dt)} ${dt.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function fmtMoney(n) {
  return (
    "₹" +
    Number(n || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** ISO yyyy-mm-dd, in local time — the date an accountant would write. */
function isoDay(d) {
  const dt = d ? new Date(d) : new Date();
  if (Number.isNaN(dt.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * A download filename that cannot break a Content-Disposition header.
 *
 * Company name, report type and as-of date, in that order, so a folder full of
 * these sorts into something readable. Everything outside `[a-z0-9-]` is
 * dropped rather than escaped: a filename is not the place to preserve a
 * comma, a quote or a newline, and each of those has been a header-injection
 * vector somewhere.
 */
function safeFilename(parts, ext) {
  const slug = parts
    .filter(Boolean)
    .map((p) =>
      String(p)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("-")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return `${slug || "report"}.${String(ext).replace(/[^a-z0-9]/gi, "")}`;
}

/** Set the download headers for a generated file. */
function setDownloadHeaders(res, { contentType, filename }) {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  // A financial report is generated per request and must never be served from
  // a shared cache — the next request may be a different company.
  res.setHeader("Cache-Control", "no-store, private");
}

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_CONTENT_TYPE = "application/pdf";

/** The name of the file each report produces. */
function outstandingFilename(report, ext) {
  return safeFilename(
    [
      report.company && report.company.companyName,
      (report.labels && report.labels.filenameStem) || "customer-outstanding",
      report.asOf ? `as-on-${isoDay(report.asOf)}` : `as-on-${isoDay(report.generatedAt)}`,
    ],
    ext,
  );
}

function statementFilename(stmt, ext) {
  const period = stmt.from
    ? `${isoDay(stmt.from)}-to-${isoDay(stmt.periodEnd || stmt.generatedAt)}`
    : `as-on-${isoDay(stmt.periodEnd || stmt.generatedAt)}`;
  return safeFilename(
    [
      stmt.company && stmt.company.companyName,
      (stmt.labels && stmt.labels.filenameStem) || "customer-ledger",
      stmt.ledger && stmt.ledger.name,
      period,
    ],
    ext,
  );
}

/**
 * The one-line count under the totals: how many parties, split by side.
 *
 * Reads the party-neutral totals and the report's own vocabulary, so a
 * supplier sheet says "12 suppliers · 9 payable · 1 in advance" and a customer
 * one says "12 customers · 9 receivable · 1 in credit" from the same code.
 */
function totalsNarrative(report) {
  const l = report.labels || {};
  const t = report.totals || {};
  const noun = l.partyPlural || "customers";
  const singular = l.party || "customer";
  const n = t.ledgerCount || 0;
  return `${n} ${n === 1 ? singular : noun} · ${t.primaryCount || 0} ${l.primaryCountNoun || "receivable"} · ${t.secondaryCount || 0} ${l.secondaryCountNoun || "in credit"}`;
}

function primaryTotalLabel(report) {
  return (report.labels && report.labels.totalPrimary) || "TOTAL RECEIVABLE (Dr)";
}

function secondaryTotalLabel(report) {
  return (
    (report.labels && report.labels.totalSecondary) || "TOTAL CUSTOMER CREDIT (Cr)"
  );
}

/** The period line printed under the title. */
function periodLabel(stmt) {
  if (stmt.from) {
    return `Period: ${fmtDate(stmt.from)} to ${fmtDate(stmt.periodEnd || stmt.generatedAt)}`;
  }
  return `As on: ${fmtDate(stmt.periodEnd || stmt.generatedAt)}`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Excel — shared scaffolding                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

function newWorkbook() {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "GRAV Accounts";
  wb.created = new Date();
  return wb;
}

/**
 * The four header rows every export shares: company, report title, as-of/period
 * and the applied filters. Returns the row index the table header goes on.
 */
function writeSheetHeader(ws, { company, title, period, filters, lastCol }) {
  const span = (row) => `A${row}:${lastCol}${row}`;

  ws.mergeCells(span(1));
  const t = ws.getCell("A1");
  t.value = (company && company.companyName) || "Company";
  t.font = { name: "Arial", size: 14, bold: true, color: { argb: INK } };
  t.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(1).height = 26;

  ws.mergeCells(span(2));
  const s = ws.getCell("A2");
  s.value = company && company.gstin ? `${title} · GSTIN ${company.gstin}` : title;
  s.font = { name: "Arial", size: 11, bold: true, color: { argb: BRAND } };

  ws.mergeCells(span(3));
  const p = ws.getCell("A3");
  p.value = period;
  p.font = { name: "Arial", size: 9, color: { argb: MUTED } };

  ws.mergeCells(span(4));
  const f = ws.getCell("A4");
  f.value = `Filters — ${filters}`;
  f.font = { name: "Arial", size: 9, color: { argb: MUTED } };

  ws.mergeCells(span(5));
  const g = ws.getCell("A5");
  g.value = `Generated: ${fmtDateTime(new Date())}`;
  g.font = { name: "Arial", size: 8, color: { argb: MUTED } };

  return 7; // row 6 stays blank; the table header lands on row 7
}

/** Paint one table-header row and return it. */
function writeTableHeader(ws, rowIdx, columns) {
  const row = ws.getRow(rowIdx);
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name: "Arial", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
    cell.alignment = { horizontal: c.align || "left", vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: BRAND } },
      bottom: { style: "thin", color: { argb: BRAND } },
      left: { style: "thin", color: { argb: BRAND } },
      right: { style: "thin", color: { argb: BRAND } },
    };
  });
  row.height = 22;
  return row;
}

function borderRow(row, colCount) {
  const thin = { style: "thin", color: { argb: "FFE2E8F0" } };
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    if (!cell.font) cell.font = { name: "Arial", size: 9 };
    cell.border = { top: thin, bottom: thin, left: thin, right: thin };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Customer Outstanding Summary — Excel                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The outstanding sheet's columns, for either party kind.
 *
 * Column 6 is always the PRIMARY half — what the party owes us for a customer,
 * what we owe them for a supplier — and column 7 the secondary. Reading the
 * key and the heading off the report keeps one writer for both sides without
 * either one inheriting the other's vocabulary: a supplier sheet that said
 * "Receivable" would be worse than a duplicated writer.
 */
function outstandingColumns(labels = {}) {
  return [
    { key: "code", label: "Code", width: 12 },
    { key: "name", label: labels.column || "Customer", width: 38 },
    { key: "gstin", label: "GSTIN", width: 20 },
    { key: "balance", label: "Outstanding", width: 16, align: "right", money: true },
    { key: "balanceType", label: "Dr/Cr", width: 8, align: "center" },
    {
      key: labels.primaryKey || "receivable",
      label: labels.primary || "Receivable (Dr)",
      width: 16,
      align: "right",
      money: true,
    },
    {
      key: labels.secondaryKey || "customerCredit",
      label: labels.secondary || "Credit (Cr)",
      width: 16,
      align: "right",
      money: true,
    },
    { key: "transactionCount", label: "Txns", width: 8, align: "right", int: true },
    { key: "lastTransactionDate", label: "Last Txn", width: 14 },
  ];
}

/** The customer column set, kept exported under its original name. */
const OUTSTANDING_COLUMNS = outstandingColumns({});

function buildOutstandingWorkbook(report) {
  const wb = newWorkbook();
  const labels = report.labels || {};
  const cols = outstandingColumns(labels);
  const lastCol = String.fromCharCode(64 + cols.length); // 9 cols → "I"

  const headerRowIdx = 7;
  const ws = wb.addWorksheet("Outstanding", {
    // Freeze BELOW the table header so the column names stay on screen while
    // an accountant scrolls two hundred customers.
    views: [{ state: "frozen", ySplit: headerRowIdx }],
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = cols.map((c) => ({ width: c.width }));

  writeSheetHeader(ws, {
    company: report.company,
    title: report.title,
    period: `As on: ${fmtDate(report.asOf || report.generatedAt)}`,
    filters: report.filterSummary,
    lastCol,
  });
  writeTableHeader(ws, headerRowIdx, cols);

  report.rows.forEach((r, i) => {
    const row = ws.getRow(headerRowIdx + 1 + i);
    cols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.key === "lastTransactionDate") {
        cell.value = fmtDate(r.lastTransactionDate);
      } else if (c.money || c.int) {
        // RULE 1: a real number, formatted for display. Never a string.
        cell.value = Number(r[c.key] || 0);
        cell.numFmt = c.money ? MONEY_FMT : INT_FMT;
      } else {
        cell.value = r[c.key] == null ? "" : String(r[c.key]);
      }
      cell.alignment = { horizontal: c.align || "left", vertical: "middle" };
      cell.font = { name: c.key === "code" ? "Consolas" : "Arial", size: 9 };
    });
    row.getCell(5).font = {
      name: "Arial",
      size: 9,
      bold: true,
      color: { argb: r.balanceType === "Cr" ? CREDIT : DEBIT },
    };
    if (i % 2 === 0) {
      for (let c = 1; c <= cols.length; c += 1) {
        row.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8FAFC" },
        };
      }
    }
    borderRow(row, cols.length);
    row.height = 18;
  });

  // ── Totals: receivables and customer credits, side by side, never netted ──
  const totalIdx = headerRowIdx + 1 + report.rows.length;
  const tr = ws.getRow(totalIdx);
  tr.getCell(1).value = "TOTAL";
  tr.getCell(2).value = totalsNarrative(report);
  tr.getCell(6).value = Number(report.totals.primaryTotal);
  tr.getCell(6).numFmt = MONEY_FMT;
  tr.getCell(7).value = Number(report.totals.secondaryTotal);
  tr.getCell(7).numFmt = MONEY_FMT;
  tr.getCell(8).value = Number(report.totals.transactionCount);
  tr.getCell(8).numFmt = INT_FMT;
  for (let c = 1; c <= cols.length; c += 1) {
    const cell = tr.getCell(c);
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
    cell.alignment = { horizontal: cols[c - 1].align || "left", vertical: "middle" };
  }
  tr.getCell(6).font = { name: "Arial", size: 10, bold: true, color: { argb: DEBIT } };
  tr.getCell(7).font = { name: "Arial", size: 10, bold: true, color: { argb: CREDIT } };
  borderRow(tr, cols.length);
  tr.height = 20;

  const netIdx = totalIdx + 2;
  ws.getCell(netIdx, 1).value = `Net — reconciles with the ${labels.group || "Sundry Debtors"} control account`;
  ws.getCell(netIdx, 1).font = { name: "Arial", size: 9, color: { argb: MUTED } };
  ws.getCell(netIdx, 6).value = Number(report.totals.netBalance);
  ws.getCell(netIdx, 6).numFmt = MONEY_FMT;
  ws.getCell(netIdx, 6).font = { name: "Arial", size: 9, bold: true, color: { argb: INK } };

  if (report.rows.length) {
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + report.rows.length, column: cols.length },
    };
  }

  return wb;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Customer Ledger / Statement — Excel                                        */
/* ────────────────────────────────────────────────────────────────────────── */

const STATEMENT_COLUMNS = [
  { key: "date", label: "Date", width: 13 },
  { key: "voucherType", label: "Voucher Type", width: 18 },
  { key: "voucherNumber", label: "Voucher No.", width: 18 },
  { key: "narration", label: "Narration", width: 46 },
  { key: "debit", label: "Debit", width: 15, align: "right", money: true },
  { key: "credit", label: "Credit", width: 15, align: "right", money: true },
  { key: "runningBalance", label: "Balance", width: 16, align: "right", money: true },
  { key: "runningType", label: "Dr/Cr", width: 8, align: "center" },
];

function buildStatementWorkbook(stmt) {
  const wb = newWorkbook();
  const cols = STATEMENT_COLUMNS;
  const lastCol = String.fromCharCode(64 + cols.length); // 8 cols → "H"
  const headerRowIdx = 7;

  const ws = wb.addWorksheet("Ledger", {
    views: [{ state: "frozen", ySplit: headerRowIdx + 1 }], // header + opening row
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = cols.map((c) => ({ width: c.width }));

  writeSheetHeader(ws, {
    company: stmt.company,
    title: `${stmt.title} — ${stmt.ledger.name}`,
    period: `${periodLabel(stmt)}${stmt.ledger.gstin ? ` · GSTIN ${stmt.ledger.gstin}` : ""} · Code ${stmt.ledger.code}`,
    filters: openingNote(stmt),
    lastCol,
  });
  writeTableHeader(ws, headerRowIdx, cols);

  // ── Opening balance is a ROW, not a note ─────────────────────────────────
  // It is the first thing the running balance builds on, so it belongs in the
  // same column as every figure that follows it.
  const openRow = ws.getRow(headerRowIdx + 1);
  openRow.getCell(1).value = stmt.from ? fmtDate(stmt.from) : "";
  openRow.getCell(4).value = "Opening Balance";
  openRow.getCell(7).value = Number(stmt.opening.amount);
  openRow.getCell(7).numFmt = MONEY_FMT;
  openRow.getCell(8).value = stmt.opening.type;
  for (let c = 1; c <= cols.length; c += 1) {
    openRow.getCell(c).font = { name: "Arial", size: 9, bold: true, color: { argb: INK } };
    openRow.getCell(c).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEEF2FF" },
    };
    openRow.getCell(c).alignment = { horizontal: cols[c - 1].align || "left", vertical: "middle" };
  }
  borderRow(openRow, cols.length);

  stmt.rows.forEach((r, i) => {
    const row = ws.getRow(headerRowIdx + 2 + i);
    cols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.key === "date") cell.value = fmtDate(r.date);
      else if (c.money) {
        cell.value = Number(r[c.key] || 0);
        cell.numFmt = MONEY_FMT;
      } else cell.value = r[c.key] == null ? "" : String(r[c.key]);
      cell.alignment = {
        horizontal: c.align || "left",
        vertical: "middle",
        wrapText: false,
      };
      cell.font = { name: c.key === "voucherNumber" ? "Consolas" : "Arial", size: 9 };
    });
    row.getCell(8).font = {
      name: "Arial",
      size: 9,
      bold: true,
      color: { argb: r.runningType === "Cr" ? CREDIT : DEBIT },
    };
    if (i % 2 === 0) {
      for (let c = 1; c <= cols.length; c += 1) {
        row.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8FAFC" },
        };
      }
    }
    borderRow(row, cols.length);
    row.height = 18;
  });

  const closeIdx = headerRowIdx + 2 + stmt.rows.length;
  const closeRow = ws.getRow(closeIdx);
  closeRow.getCell(4).value = "Closing Balance";
  closeRow.getCell(5).value = Number(stmt.totals.debit);
  closeRow.getCell(5).numFmt = MONEY_FMT;
  closeRow.getCell(6).value = Number(stmt.totals.credit);
  closeRow.getCell(6).numFmt = MONEY_FMT;
  closeRow.getCell(7).value = Number(stmt.closing.amount);
  closeRow.getCell(7).numFmt = MONEY_FMT;
  closeRow.getCell(8).value = stmt.closing.type;
  for (let c = 1; c <= cols.length; c += 1) {
    const cell = closeRow.getCell(c);
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
    cell.alignment = { horizontal: cols[c - 1].align || "left", vertical: "middle" };
  }
  closeRow.getCell(8).font = {
    name: "Arial",
    size: 10,
    bold: true,
    color: { argb: stmt.closing.type === "Cr" ? CREDIT : DEBIT },
  };
  borderRow(closeRow, cols.length);
  closeRow.height = 20;

  if (stmt.rows.length) {
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + 1 + stmt.rows.length, column: cols.length },
    };
  }

  return wb;
}

/**
 * The sentence that explains where the opening balance came from.
 *
 * On a date-range statement this is the difference between a trustworthy
 * document and a plausible one — see the note on `customerLedgerStatement`.
 */
function openingNote(stmt) {
  if (!stmt.from) {
    return "Opening balance is the ledger master opening balance; all posted, non-optional vouchers to date are listed.";
  }
  return `Opening balance at ${fmtDate(stmt.from)} = ledger opening ${fmtMoney(Math.abs(stmt.opening.masterOpening))} ${stmt.opening.masterOpening < 0 ? "Cr" : "Dr"} plus ${stmt.opening.priorVoucherCount} earlier posted voucher${stmt.opening.priorVoucherCount === 1 ? "" : "s"}.`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* PDF — shared scaffolding                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const A4 = { portrait: { w: 595.28, h: 841.89 }, landscape: { w: 841.89, h: 595.28 } };
const MARGIN = 36;

function newDoc(orientation) {
  const PDFDocument = require("pdfkit");
  return new PDFDocument({
    size: "A4",
    layout: orientation,
    margin: MARGIN,
    // pdfkit adds a first page on construction; we drive pagination ourselves.
    autoFirstPage: true,
    bufferPages: true,
  });
}

/**
 * Draw one cell of text so it CANNOT clip and CANNOT wrap.
 *
 * `lineBreak: false` keeps the text on one line and `ellipsis: true` truncates
 * it at the column width — which together are what stop a long narration from
 * running under the Debit column or pushing the row's real height past the
 * height the pagination arithmetic assumed.
 */
function cellText(doc, text, x, y, width, opts = {}) {
  doc.text(String(text == null ? "" : text), x, y, {
    width,
    align: opts.align || "left",
    lineBreak: false,
    ellipsis: true,
  });
}

/**
 * The page furniture: company, title, period, filters, and the generated
 * timestamp + page number in the footer. Returns the y the table starts at.
 */
function drawPageHead(doc, { company, title, period, filters }, pageWidth) {
  const right = MARGIN + pageWidth;
  doc.fontSize(15).font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(doc, (company && company.companyName) || "Company", MARGIN, MARGIN, pageWidth);
  doc.fontSize(10.5).font("Helvetica-Bold").fillColor(PDF_BRAND);
  cellText(doc, title, MARGIN, MARGIN + 20, pageWidth);
  doc.fontSize(8).font("Helvetica").fillColor(PDF_MUTED);
  cellText(
    doc,
    company && company.gstin ? `${period} · GSTIN ${company.gstin}` : period,
    MARGIN,
    MARGIN + 36,
    pageWidth,
  );
  doc.fontSize(7.5).fillColor(PDF_FAINT);
  cellText(doc, filters, MARGIN, MARGIN + 48, pageWidth);
  doc
    .moveTo(MARGIN, MARGIN + 62)
    .lineTo(right, MARGIN + 62)
    .strokeColor(PDF_HAIRLINE)
    .lineWidth(1)
    .stroke();
  return MARGIN + 70;
}

/** Header band for a table, repeated at the top of every page. */
function drawTableHeader(doc, columns, y, pageWidth) {
  doc.rect(MARGIN, y, pageWidth, 18).fill(PDF_BRAND);
  doc.fontSize(7).font("Helvetica-Bold").fillColor("#ffffff");
  for (const c of columns) {
    cellText(doc, c.label.toUpperCase(), c.x + 3, y + 5.5, c.w - 6, { align: c.align });
  }
  return y + 18;
}

/**
 * Stamp "Page n of m · generated …" onto every buffered page.
 *
 * Done at the end because the total page count is not known until the last row
 * is drawn, and a footer that says "Page 3" without saying of how many is the
 * one that lets a page go missing from a printed report unnoticed.
 */
function stampFooters(doc, { pageWidth, pageHeight, note }) {
  const range = doc.bufferedPageRange();
  const generated = `Generated ${fmtDateTime(new Date())}`;
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    /* THE FOOTER SITS BELOW THE BOTTOM MARGIN — THAT IS WHAT A FOOTER IS.
     *
     * pdfkit does not know that: `text()` at a y whose line would cross
     * `maxY()` silently ADDS A PAGE and writes there instead. With three
     * footer calls per page that turned every export into four times the pages
     * it drew — a one-page statement arrived as one page of content followed by
     * three blanks, and the "Page 1 of 1" stamped on it was computed before any
     * of them existed.
     *
     * Clearing the bottom margin on the page being stamped moves `maxY()` to
     * the paper edge, so the footer lands where it was asked to. Safe because
     * footers are the last thing drawn on a finished page — nothing after this
     * loop paginates. */
    doc.page.margins.bottom = 0;
    const y = pageHeight - MARGIN + 6;
    doc.fontSize(7).font("Helvetica").fillColor(PDF_FAINT);
    doc.text(generated, MARGIN, y, { width: pageWidth / 3, align: "left", lineBreak: false });
    doc.text(note || "", MARGIN + pageWidth / 3, y, {
      width: pageWidth / 3,
      align: "center",
      lineBreak: false,
      ellipsis: true,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + (2 * pageWidth) / 3, y, {
      width: pageWidth / 3,
      align: "right",
      lineBreak: false,
    });
  }
}

/**
 * Lay columns out left to right inside the usable width.
 *
 * Widths are given as weights and scaled to fit exactly, so no column can be
 * pushed off the right edge by a change to another one — the arithmetic that
 * used to be done by hand, and got a column clipped every time a label grew.
 */
function layoutColumns(specs, pageWidth) {
  const total = specs.reduce((s, c) => s + c.w, 0);
  const scale = pageWidth / total;
  let x = MARGIN;
  return specs.map((c) => {
    const w = c.w * scale;
    const out = { ...c, x, w };
    x += w;
    return out;
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Customer Outstanding Summary — PDF                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function writeOutstandingPdf(report, stream) {
  const { w: pw, h: ph } = A4.portrait;
  const pageWidth = pw - MARGIN * 2;
  const doc = newDoc("portrait");
  doc.pipe(stream);

  const columns = layoutColumns(
    [
      { key: "code", label: "Code", w: 58 },
      { key: "name", label: (report.labels && report.labels.column) || "Customer", w: 150 },
      { key: "gstin", label: "GSTIN", w: 100 },
      { key: "balance", label: "Outstanding", w: 82, align: "right" },
      { key: "balanceType", label: "Dr/Cr", w: 32, align: "center" },
      { key: "transactionCount", label: "Txns", w: 32, align: "right" },
      { key: "lastTransactionDate", label: "Last Txn", w: 69, align: "right" },
    ],
    pageWidth,
  );

  const head = {
    company: report.company,
    title: report.title,
    period: `As on: ${fmtDate(report.asOf || report.generatedAt)}`,
    filters: report.filterSummary,
  };

  let y = drawPageHead(doc, head, pageWidth);
  y = drawTableHeader(doc, columns, y, pageWidth);

  const ROW_H = 15;
  // Reserve room for the totals block AND the footer so neither can be
  // orphaned onto a page of its own or drawn over the page number.
  const bottom = ph - MARGIN - 16;

  const newPage = () => {
    doc.addPage();
    let ny = drawPageHead(doc, head, pageWidth);
    return drawTableHeader(doc, columns, ny, pageWidth);
  };

  report.rows.forEach((r, i) => {
    // The break is decided BEFORE anything of this row is drawn — a row is
    // never split across two pages.
    if (y + ROW_H > bottom) y = newPage();
    if (i % 2 === 0) doc.rect(MARGIN, y, pageWidth, ROW_H).fill(PDF_BAND);

    const c = (k) => columns.find((x) => x.key === k);
    doc.fontSize(7).font("Courier").fillColor(PDF_BRAND);
    cellText(doc, r.code, c("code").x + 3, y + 4, c("code").w - 6);
    doc.font("Helvetica").fillColor(PDF_INK);
    cellText(doc, r.name, c("name").x + 3, y + 4, c("name").w - 6);
    doc.fontSize(6.5).font("Courier").fillColor(PDF_MUTED);
    cellText(doc, r.gstin || "—", c("gstin").x + 3, y + 4.5, c("gstin").w - 6);
    doc
      .fontSize(7.5)
      .font("Courier-Bold")
      .fillColor(r.balanceType === "Cr" ? PDF_CREDIT : PDF_DEBIT);
    cellText(doc, fmtMoney(r.balance), c("balance").x + 3, y + 4, c("balance").w - 6, {
      align: "right",
    });
    doc.fontSize(7).font("Helvetica-Bold");
    cellText(doc, r.balanceType, c("balanceType").x + 3, y + 4, c("balanceType").w - 6, {
      align: "center",
    });
    doc.font("Helvetica").fillColor(PDF_INK);
    cellText(
      doc,
      String(r.transactionCount || 0),
      c("transactionCount").x + 3,
      y + 4,
      c("transactionCount").w - 6,
      { align: "right" },
    );
    doc.fillColor(PDF_MUTED);
    cellText(
      doc,
      fmtDate(r.lastTransactionDate) || "—",
      c("lastTransactionDate").x + 3,
      y + 4,
      c("lastTransactionDate").w - 6,
      { align: "right" },
    );
    y += ROW_H;
  });

  // ── Totals: two lines, never one ─────────────────────────────────────────
  const TOTALS_H = 54;
  if (y + TOTALS_H > bottom) y = newPage();
  y += 4;
  doc.rect(MARGIN, y, pageWidth, 17).fill("#eef2ff");
  doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(doc, primaryTotalLabel(report), MARGIN + 4, y + 5, pageWidth * 0.6);
  doc.font("Courier-Bold").fillColor(PDF_DEBIT);
  cellText(doc, fmtMoney(report.totals.primaryTotal), MARGIN + pageWidth * 0.6, y + 5, pageWidth * 0.4 - 4, { align: "right" });
  y += 18;
  doc.rect(MARGIN, y, pageWidth, 17).fill("#ecfdf5");
  doc.font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(doc, secondaryTotalLabel(report), MARGIN + 4, y + 5, pageWidth * 0.6);
  doc.font("Courier-Bold").fillColor(PDF_CREDIT);
  cellText(doc, fmtMoney(report.totals.secondaryTotal), MARGIN + pageWidth * 0.6, y + 5, pageWidth * 0.4 - 4, { align: "right" });
  y += 18;
  doc.fontSize(7).font("Helvetica").fillColor(PDF_MUTED);
  cellText(
    doc,
    `${totalsNarrative(report)} · net ${fmtMoney(report.totals.netBalance)} ${(report.labels && report.labels.primarySide) || "Dr"}`,
    MARGIN + 4,
    y + 4,
    pageWidth - 8,
  );

  stampFooters(doc, {
    pageWidth,
    pageHeight: ph,
    note: `${(report.company && report.company.companyName) || ""} · Confidential`,
  });
  doc.end();
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Customer Ledger / Statement — PDF                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function writeStatementPdf(stmt, stream) {
  const { w: pw, h: ph } = A4.landscape;
  const pageWidth = pw - MARGIN * 2;
  const doc = newDoc("landscape");
  doc.pipe(stream);

  const columns = layoutColumns(
    [
      { key: "date", label: "Date", w: 62 },
      { key: "voucherType", label: "Voucher Type", w: 84 },
      { key: "voucherNumber", label: "Voucher No.", w: 90 },
      { key: "narration", label: "Narration", w: 210 },
      { key: "debit", label: "Debit", w: 84, align: "right" },
      { key: "credit", label: "Credit", w: 84, align: "right" },
      { key: "runningBalance", label: "Balance", w: 90, align: "right" },
      { key: "runningType", label: "Dr/Cr", w: 36, align: "center" },
    ],
    pageWidth,
  );

  const head = {
    company: stmt.company,
    title: `${stmt.title} — ${stmt.ledger.name}`,
    period: `${periodLabel(stmt)} · Code ${stmt.ledger.code}${stmt.ledger.gstin ? ` · GSTIN ${stmt.ledger.gstin}` : ""}`,
    filters: openingNote(stmt),
  };

  const c = (k) => columns.find((x) => x.key === k);
  const ROW_H = 15;
  const bottom = ph - MARGIN - 16;

  const drawBalanceBand = (label, amount, type, y) => {
    doc.rect(MARGIN, y, pageWidth, 17).fill(type === "Cr" ? "#ecfdf5" : "#eef2ff");
    doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
    cellText(doc, label, c("narration").x + 3, y + 5, c("narration").w - 6);
    doc.font("Courier-Bold").fillColor(type === "Cr" ? PDF_CREDIT : PDF_DEBIT);
    cellText(doc, fmtMoney(amount), c("runningBalance").x + 3, y + 5, c("runningBalance").w - 6, {
      align: "right",
    });
    doc.font("Helvetica-Bold");
    cellText(doc, type, c("runningType").x + 3, y + 5, c("runningType").w - 6, { align: "center" });
    return y + 17;
  };

  let y = drawPageHead(doc, head, pageWidth);
  y = drawTableHeader(doc, columns, y, pageWidth);

  const newPage = () => {
    doc.addPage();
    const ny = drawPageHead(doc, head, pageWidth);
    return drawTableHeader(doc, columns, ny, pageWidth);
  };

  // OPENING — the first band, before any movement.
  y = drawBalanceBand("Opening Balance", stmt.opening.amount, stmt.opening.type, y);

  stmt.rows.forEach((r, i) => {
    if (y + ROW_H > bottom) y = newPage();
    if (i % 2 === 0) doc.rect(MARGIN, y, pageWidth, ROW_H).fill(PDF_BAND);

    doc.fontSize(7).font("Helvetica").fillColor(PDF_INK);
    cellText(doc, fmtDate(r.date), c("date").x + 3, y + 4, c("date").w - 6);
    cellText(doc, r.voucherType, c("voucherType").x + 3, y + 4, c("voucherType").w - 6);
    doc.font("Courier").fillColor(PDF_BRAND);
    cellText(doc, r.voucherNumber || "—", c("voucherNumber").x + 3, y + 4, c("voucherNumber").w - 6);
    doc.fontSize(6.5).font("Helvetica").fillColor(PDF_MUTED);
    cellText(doc, r.narration || r.counterParty || "—", c("narration").x + 3, y + 4.5, c("narration").w - 6);
    doc.fontSize(7).font("Courier").fillColor(r.debit ? PDF_DEBIT : PDF_FAINT);
    cellText(doc, r.debit ? fmtMoney(r.debit) : "—", c("debit").x + 3, y + 4, c("debit").w - 6, { align: "right" });
    doc.fillColor(r.credit ? PDF_CREDIT : PDF_FAINT);
    cellText(doc, r.credit ? fmtMoney(r.credit) : "—", c("credit").x + 3, y + 4, c("credit").w - 6, { align: "right" });
    doc.font("Courier-Bold").fillColor(PDF_INK);
    cellText(doc, fmtMoney(r.runningBalance), c("runningBalance").x + 3, y + 4, c("runningBalance").w - 6, {
      align: "right",
    });
    doc.font("Helvetica-Bold").fillColor(r.runningType === "Cr" ? PDF_CREDIT : PDF_DEBIT);
    cellText(doc, r.runningType, c("runningType").x + 3, y + 4, c("runningType").w - 6, { align: "center" });
    y += ROW_H;
  });

  // TOTALS + CLOSING — kept together; a closing balance separated from the
  // movement that produced it is what makes a statement look tampered with.
  if (y + 40 > bottom) y = newPage();
  doc.rect(MARGIN, y, pageWidth, 17).fill("#f1f5f9");
  doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(doc, `Total movement · ${stmt.totals.transactionCount} voucher${stmt.totals.transactionCount === 1 ? "" : "s"}`, c("narration").x + 3, y + 5, c("narration").w - 6);
  doc.font("Courier-Bold").fillColor(PDF_DEBIT);
  cellText(doc, fmtMoney(stmt.totals.debit), c("debit").x + 3, y + 5, c("debit").w - 6, { align: "right" });
  doc.fillColor(PDF_CREDIT);
  cellText(doc, fmtMoney(stmt.totals.credit), c("credit").x + 3, y + 5, c("credit").w - 6, { align: "right" });
  y += 17;
  y = drawBalanceBand("Closing Balance", stmt.closing.amount, stmt.closing.type, y);

  stampFooters(doc, {
    pageWidth,
    pageHeight: ph,
    note: `${(stmt.company && stmt.company.companyName) || ""} · ${stmt.ledger.name}`,
  });
  doc.end();
  return doc;
}


/* ────────────────────────────────────────────────────────────────────────── */
/* Invoice-wise Ageing — Excel (either party kind)                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Two sheets, because an ageing report answers two questions.
 *
 *   "Ageing"   one row per CUSTOMER, bucketed — what a credit controller reads
 *              first, and the sheet that ties to the Outstanding Summary.
 *   "Invoices" one row per OPEN BILL — the evidence behind every bucket, with
 *              the due date and WHERE that due date came from.
 *
 * The disclosure columns (bill credits, unallocated) sit on the party sheet
 * beside the buckets rather than under them: they are not ages, and a reader
 * scanning the bucket columns must not be able to add them in by accident.
 */
function ageingPartyColumns(labels = {}) {
  return [
  { key: "code", label: "Code", width: 12 },
  { key: "name", label: labels.column || "Customer", width: 34 },
  { key: "gstin", label: "GSTIN", width: 20 },
  { bucket: "notYetDue", label: "Not yet due", width: 15, money: true },
  { bucket: "d1_30", label: "1-30 days", width: 15, money: true },
  { bucket: "d31_60", label: "31-60 days", width: 15, money: true },
  { bucket: "d61_90", label: "61-90 days", width: 15, money: true },
  { bucket: "d90plus", label: "90+ days", width: 15, money: true },
  { bucket: "unknown", label: "Date unavailable", width: 17, money: true },
  { key: "agedTotal", label: "Aged total", width: 16, money: true },
  { key: "billOpposite", label: labels.billOpposite || "Bill credits", width: 16, money: true },
  { key: "unallocatedPrimary", label: labels.unallocatedPrimaryCol || "Unallocated Dr", width: 17, money: true },
  { key: "unallocatedSecondary", label: labels.unallocatedSecondaryCol || "Unallocated Cr", width: 19, money: true },
  { key: "ledgerBalance", label: "Ledger balance", width: 16, money: true },
  { key: "ledgerBalanceType", label: "Dr/Cr", width: 8, align: "center" },
  ];
}

/** The customer column set, kept exported under its original name. */
const AGEING_PARTY_COLUMNS = ageingPartyColumns({});

function ageingInvoiceColumns(labels = {}) {
  const Bill = (labels.billNoun || "invoice").replace(/^./, (c) => c.toUpperCase());
  return [
  { key: "code", label: "Code", width: 12 },
  { key: "name", label: labels.column || "Customer", width: 30 },
  { key: "billName", label: labels.billRefLabel || "Invoice / Ref", width: 22 },
  { key: "voucherType", label: "Voucher Type", width: 16 },
  { key: "invoiceDate", label: `${Bill} Date`, width: 14, date: true },
  { key: "dueDate", label: "Due Date", width: 14, date: true },
  { key: "dueDateSource", label: "Due Date From", width: 16 },
  { key: "originalAmount", label: `${Bill} Amount`, width: 16, money: true },
  { key: "remaining", label: "Outstanding", width: 16, money: true },
  { key: "daysOverdue", label: "Days Overdue", width: 13, int: true },
  { key: "bucket", label: "Bucket", width: 16 },
  ];
}

const AGEING_INVOICE_COLUMNS = ageingInvoiceColumns({});

/**
 * How a due date was established, in words a reader can audit.
 *
 * Only the derived one differs between the two sides — a customer's is dated
 * from an invoice, a supplier's from a bill — so the party's own wording comes
 * off the report rather than being hard-coded here. The default keeps the
 * customer string for any caller that passes no labels.
 */
function dueSourceLabels(labels = {}) {
  return {
    allocation: "Bill allocation",
    voucher: "Voucher header",
    creditDays: labels.creditDaysSourceLabel || "Invoice + credit days",
    none: "Not available",
  };
}

/** The customer labels, kept exported under the original name. */
const DUE_SOURCE_LABEL = dueSourceLabels({});

function buildAgeingWorkbook(report) {
  const wb = newWorkbook();
  const L = report.labels || {};
  const bucketLabel = (k) =>
    (report.buckets || []).find((b) => b.key === k)?.label || k;

  /* ── Sheet 1: by party ────────────────────────────────────────────────── */
  const cols = ageingPartyColumns(L);
  const lastCol = String.fromCharCode(64 + cols.length);
  const headerRowIdx = 7;
  const ws = wb.addWorksheet("Ageing", {
    views: [{ state: "frozen", ySplit: headerRowIdx, xSplit: 2 }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = cols.map((c) => ({ width: c.width }));

  writeSheetHeader(ws, {
    company: report.company,
    title: report.title,
    period: `As on: ${fmtDate(report.asOf || report.generatedAt)}`,
    filters: report.filterSummary,
    lastCol,
  });
  writeTableHeader(
    ws,
    headerRowIdx,
    cols.map((c) => ({
      label: c.bucket ? bucketLabel(c.bucket) : c.label,
      align: c.align || (c.money || c.int ? "right" : "left"),
    })),
  );

  report.parties.forEach((p, i) => {
    const row = ws.getRow(headerRowIdx + 1 + i);
    cols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.bucket) {
        cell.value = Number(p.buckets[c.bucket] || 0);
        cell.numFmt = MONEY_FMT;
      } else if (c.money) {
        cell.value = Number(p[c.key] || 0);
        cell.numFmt = MONEY_FMT;
      } else {
        cell.value = p[c.key] == null ? "" : String(p[c.key]);
      }
      cell.alignment = {
        horizontal: c.align || (c.money ? "right" : "left"),
        vertical: "middle",
      };
      cell.font = { name: c.key === "code" ? "Consolas" : "Arial", size: 9 };
    });
    if (i % 2 === 0) {
      for (let c = 1; c <= cols.length; c += 1) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    }
    borderRow(row, cols.length);
    row.height = 18;
  });

  const totalIdx = headerRowIdx + 1 + report.parties.length;
  const tr = ws.getRow(totalIdx);
  tr.getCell(1).value = "TOTAL";
  tr.getCell(2).value = `${report.totals.partyCount} ${report.totals.partyCount === 1 ? L.party || "customer" : L.partyPlural || "customers"} · ${report.totals.openBillCount} open ${report.totals.openBillCount === 1 ? L.billNoun || "bill" : L.billNounPlural || "bills"}`;
  cols.forEach((c, ci) => {
    if (!c.bucket && !c.money) return;
    const cell = tr.getCell(ci + 1);
    cell.value = Number(
      c.bucket ? report.totals.buckets[c.bucket] || 0 : report.totals[c.key] || 0,
    );
    cell.numFmt = MONEY_FMT;
  });
  for (let c = 1; c <= cols.length; c += 1) {
    const cell = tr.getCell(c);
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
    cell.alignment = { horizontal: cols[c - 1].money || cols[c - 1].bucket ? "right" : "left", vertical: "middle" };
  }
  borderRow(tr, cols.length);
  tr.height = 20;

  /* ── The tie-out, stated on the sheet ─────────────────────────────────── */
  const rec = totalIdx + 2;
  const aged = L.agedNoun || "receivables";
  const opposite = (L.billOpposite || "bill credits").toLowerCase();
  const lines = [
    [`Aged ${aged} (bucketed)`, report.totals.agedTotal],
    [`less ${opposite}`, -report.totals.billOpposite],
    [L.unallocatedPrimaryLine || "plus unallocated debit (opening / on-account)", report.totals.unallocatedPrimary],
    [L.unallocatedSecondaryLine || "less unallocated credit", -report.totals.unallocatedSecondary],
    ["= Ledger balances (nets to the Outstanding Summary)", null],
    [`${L.primaryLabel || "Receivable"} per ${L.outstandingReportTitle || "Outstanding Summary"}`, report.totals.ledgerPrimary],
    [`${L.secondaryLabel || "Credit"} per Outstanding Summary`, report.totals.ledgerSecondary],
  ];
  ws.getCell(rec - 1, 1).value = "RECONCILIATION";
  ws.getCell(rec - 1, 1).font = { name: "Arial", size: 10, bold: true, color: { argb: INK } };
  lines.forEach(([label, value], i) => {
    ws.getCell(rec + i, 1).value = label;
    ws.getCell(rec + i, 1).font = { name: "Arial", size: 9, color: { argb: MUTED } };
    if (value !== null) {
      const cell = ws.getCell(rec + i, 10);
      cell.value = Number(value);
      cell.numFmt = MONEY_FMT;
      cell.font = { name: "Arial", size: 9, bold: true, color: { argb: INK } };
    }
  });
  ws.getCell(rec + lines.length, 1).value = report.reconciliation.reconciles
    ? `Every ${L.party || "customer"} reconciles: aged − ${opposite} + unallocated = ledger balance.`
    : `OUT OF BALANCE for ${report.reconciliation.partiesOutOfBalance.length} ${L.party || "customer"}(s).`;
  ws.getCell(rec + lines.length, 1).font = {
    name: "Arial",
    size: 9,
    bold: true,
    color: { argb: report.reconciliation.reconciles ? CREDIT : DEBIT },
  };

  if (report.parties.length) {
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + report.parties.length, column: cols.length },
    };
  }

  /* ── Sheet 2: the bills behind the buckets ────────────────────────────── */
  const icols = ageingInvoiceColumns(L);
  const dueSource = dueSourceLabels(L);
  const iws = wb.addWorksheet(L.detailSheetName || "Invoices", {
    views: [{ state: "frozen", ySplit: headerRowIdx }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  iws.columns = icols.map((c) => ({ width: c.width }));
  writeSheetHeader(iws, {
    company: report.company,
    title: `${report.title} — open ${L.billNounPlural || "bills"}`,
    period: `As on: ${fmtDate(report.asOf || report.generatedAt)}`,
    filters: report.filterSummary,
    lastCol: String.fromCharCode(64 + icols.length),
  });
  writeTableHeader(
    iws,
    headerRowIdx,
    icols.map((c) => ({ label: c.label, align: c.money || c.int ? "right" : "left" })),
  );

  report.rows.forEach((r, i) => {
    const row = iws.getRow(headerRowIdx + 1 + i);
    icols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.date) cell.value = fmtDate(r[c.key]);
      else if (c.money) {
        cell.value = Number(r[c.key] || 0);
        cell.numFmt = MONEY_FMT;
      } else if (c.int) {
        cell.value = r[c.key] == null ? "" : Number(r[c.key]);
        if (r[c.key] != null) cell.numFmt = INT_FMT;
      } else if (c.key === "dueDateSource") {
        cell.value = dueSource[r.dueDateSource] || r.dueDateSource;
      } else if (c.key === "bucket") {
        cell.value = bucketLabel(r.bucket);
      } else {
        cell.value = r[c.key] == null ? "" : String(r[c.key]);
      }
      cell.alignment = {
        horizontal: c.money || c.int ? "right" : "left",
        vertical: "middle",
      };
      cell.font = { name: c.key === "billName" ? "Consolas" : "Arial", size: 9 };
    });
    if (i % 2 === 0) {
      for (let c = 1; c <= icols.length; c += 1) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    }
    borderRow(row, icols.length);
    row.height = 18;
  });

  const itotal = iws.getRow(headerRowIdx + 1 + report.rows.length);
  itotal.getCell(1).value = "TOTAL";
  itotal.getCell(9).value = Number(report.totals.agedTotal);
  itotal.getCell(9).numFmt = MONEY_FMT;
  for (let c = 1; c <= icols.length; c += 1) {
    itotal.getCell(c).font = { name: "Arial", size: 10, bold: true, color: { argb: INK } };
    itotal.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
  }
  borderRow(itotal, icols.length);

  if (report.rows.length) {
    iws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + report.rows.length, column: icols.length },
    };
  }

  return wb;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Invoice-wise Ageing — PDF (either party kind)                              */
/* ────────────────────────────────────────────────────────────────────────── */

function writeAgeingPdf(report, stream) {
  const L = report.labels || {};
  const { w: pw, h: ph } = A4.landscape;
  const pageWidth = pw - MARGIN * 2;
  const doc = newDoc("landscape");
  doc.pipe(stream);

  const bucketLabel = (k) => (report.buckets || []).find((b) => b.key === k)?.label || k;

  const columns = layoutColumns(
    [
      { key: "code", label: "Code", w: 56 },
      { key: "name", label: (report.labels && report.labels.column) || "Customer", w: 150 },
      { key: "notYetDue", label: bucketLabel("notYetDue"), w: 80, align: "right", bucket: true },
      { key: "d1_30", label: bucketLabel("d1_30"), w: 76, align: "right", bucket: true },
      { key: "d31_60", label: bucketLabel("d31_60"), w: 76, align: "right", bucket: true },
      { key: "d61_90", label: bucketLabel("d61_90"), w: 76, align: "right", bucket: true },
      { key: "d90plus", label: bucketLabel("d90plus"), w: 76, align: "right", bucket: true },
      { key: "unknown", label: "Undated", w: 76, align: "right", bucket: true },
      { key: "agedTotal", label: "Aged total", w: 84, align: "right" },
    ],
    pageWidth,
  );

  const head = {
    company: report.company,
    title: report.title,
    period: `As on: ${fmtDate(report.asOf || report.generatedAt)}`,
    filters: report.filterSummary,
  };

  let y = drawPageHead(doc, head, pageWidth);
  y = drawTableHeader(doc, columns, y, pageWidth);

  const ROW_H = 15;
  const bottom = ph - MARGIN - 16;
  const newPage = () => {
    doc.addPage();
    return drawTableHeader(doc, columns, drawPageHead(doc, head, pageWidth), pageWidth);
  };

  report.parties.forEach((p, i) => {
    if (y + ROW_H > bottom) y = newPage();
    if (i % 2 === 0) doc.rect(MARGIN, y, pageWidth, ROW_H).fill(PDF_BAND);
    for (const c of columns) {
      const isMoney = c.bucket || c.key === "agedTotal";
      const value = c.bucket ? p.buckets[c.key] : p[c.key];
      doc.fontSize(7);
      if (c.key === "code") doc.font("Courier").fillColor(PDF_BRAND);
      else if (isMoney) {
        doc.font(c.key === "agedTotal" ? "Courier-Bold" : "Courier");
        doc.fillColor(c.key === "d90plus" && value > 0 ? PDF_DEBIT : PDF_INK);
      } else doc.font("Helvetica").fillColor(PDF_INK);
      cellText(
        doc,
        isMoney ? (value ? fmtMoney(value) : "—") : value,
        c.x + 3,
        y + 4,
        c.w - 6,
        { align: c.align },
      );
    }
    y += ROW_H;
  });

  // Totals band
  if (y + 20 > bottom) y = newPage();
  doc.rect(MARGIN, y, pageWidth, 17).fill("#eef2ff");
  doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(doc, "TOTAL", columns[0].x + 3, y + 5, columns[1].w);
  for (const c of columns) {
    if (!c.bucket && c.key !== "agedTotal") continue;
    const v = c.bucket ? report.totals.buckets[c.key] : report.totals.agedTotal;
    doc.font("Courier-Bold").fillColor(PDF_INK);
    cellText(doc, fmtMoney(v), c.x + 3, y + 5, c.w - 6, { align: "right" });
  }
  y += 21;

  /* ── The tie-out, on the page rather than in a footnote ───────────────── */
  const RECON_H = 76;
  if (y + RECON_H > bottom) y = newPage();
  doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(
    doc,
    `RECONCILIATION TO THE ${(L.outstandingReportTitle || "Outstanding Summary").toUpperCase()}`,
    MARGIN,
    y,
    pageWidth,
  );
  y += 12;
  const recLines = [
    [`Aged ${L.agedNoun || "receivables"} (bucketed above)`, report.totals.agedTotal],
    [`less ${(L.billOpposite || "bill credits").toLowerCase()} (${L.billOppositeHint || "settled past zero"})`, -report.totals.billOpposite],
    [L.unallocatedPrimaryLine || "plus unallocated debit (opening / on-account)", report.totals.unallocatedPrimary],
    [L.unallocatedSecondaryLinePdf || L.unallocatedSecondaryLine || "less unallocated credit (advances on account)", -report.totals.unallocatedSecondary],
    [`${L.primaryLabel || "Receivable"} per Outstanding Summary, same date`, report.totals.ledgerPrimary],
    [`${L.secondaryLabel || "Credit"} per Outstanding Summary`, report.totals.ledgerSecondary],
  ];
  for (const [label, value] of recLines) {
    doc.fontSize(7.5).font("Helvetica").fillColor(PDF_MUTED);
    cellText(doc, label, MARGIN + 4, y, pageWidth * 0.6);
    doc.font("Courier").fillColor(value < 0 ? PDF_CREDIT : PDF_INK);
    cellText(doc, fmtMoney(value), MARGIN + pageWidth * 0.6, y, pageWidth * 0.4 - 4, {
      align: "right",
    });
    y += 10;
  }
  doc.fontSize(7.5).font("Helvetica-Bold");
  doc.fillColor(report.reconciliation.reconciles ? PDF_CREDIT : PDF_DEBIT);
  cellText(
    doc,
    report.reconciliation.reconciles
      ? `All ${report.totals.partyCount} ${L.partyPlural || "customers"} reconcile · ${report.totals.undatedBillCount} ${L.billNoun || "bill"}(s) have no due date and are shown as "Date unavailable".`
      : `OUT OF BALANCE for ${report.reconciliation.partiesOutOfBalance.length} ${L.party || "customer"}(s).`,
    MARGIN + 4,
    y + 2,
    pageWidth - 8,
  );

  stampFooters(doc, {
    pageWidth,
    pageHeight: ph,
    note: `${(report.company && report.company.companyName) || ""} · Confidential`,
  });
  doc.end();
  return doc;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Statement packs — many parties, one download (either party kind)           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A download filename per party, guaranteed distinct.
 *
 * Two customers legitimately share a name — "Acme Exports" in Surat and in
 * Tiruppur — and `safeFilename` slugs them identically. In a ZIP the second
 * entry would overwrite the first, and the user would open a pack of 40
 * statements to find 39. So a repeat gets the party's own code appended, and
 * a repeat of THAT gets an index: deterministic, and still readable.
 *
 * Exported because the manifest and the archive entries have to agree, and the
 * only way to guarantee that is for both to read the same list.
 */
function packFilenames(pack, ext) {
  const used = new Map();
  return (pack.statements || []).map((s, i) => {
    const base = safeFilename(
      [s.ledger && s.ledger.name, packPeriodSlug(pack)],
      ext,
    ).replace(new RegExp(`\\.${ext}$`), "");
    let name = base;
    if (used.has(name)) {
      name = safeFilename([base, s.ledger && s.ledger.code], ext).replace(
        new RegExp(`\\.${ext}$`),
        "",
      );
    }
    if (used.has(name)) name = `${name}-${i + 1}`;
    used.set(name, true);
    return `${name}.${ext}`;
  });
}

/** The period as a filename fragment, shared by the pack and its entries. */
function packPeriodSlug(pack) {
  return pack.from
    ? `${isoDay(pack.from)}-to-${isoDay(pack.periodEnd || pack.generatedAt)}`
    : `as-on-${isoDay(pack.periodEnd || pack.generatedAt)}`;
}

/** The pack's own download filename. */
function packFilename(pack, ext) {
  return safeFilename(
    [
      pack.company && pack.company.companyName,
      (pack.labels && pack.labels.filenameStem) || "statements",
      packPeriodSlug(pack),
    ],
    ext,
  );
}

/** The period line every document in a pack carries. */
function packPeriodLabel(pack) {
  return pack.from
    ? `Period: ${fmtDate(pack.from)} to ${fmtDate(pack.periodEnd || pack.generatedAt)}`
    : `As on: ${fmtDate(pack.periodEnd || pack.generatedAt)}`;
}

const PACK_SUMMARY_COLUMNS = [
  { key: "code", label: "Code", width: 12 },
  { key: "name", label: "Party", width: 38 },
  { key: "gstin", label: "GSTIN", width: 20 },
  { key: "openingBalance", label: "Opening", width: 16, money: true },
  { key: "openingType", label: "Dr/Cr", width: 8, align: "center" },
  { key: "debit", label: "Debit", width: 16, money: true },
  { key: "credit", label: "Credit", width: 16, money: true },
  { key: "closingBalance", label: "Closing", width: 16, money: true },
  { key: "closingType", label: "Dr/Cr", width: 8, align: "center" },
  { key: "transactionCount", label: "Txns", width: 8, align: "right", int: true },
];

const PACK_TXN_COLUMNS = [
  { key: "code", label: "Code", width: 12 },
  { key: "name", label: "Party", width: 30 },
  { key: "date", label: "Date", width: 13, date: true },
  { key: "voucherType", label: "Voucher Type", width: 18 },
  { key: "voucherNumber", label: "Voucher No.", width: 18 },
  { key: "narration", label: "Narration", width: 40 },
  { key: "debit", label: "Debit", width: 15, money: true },
  { key: "credit", label: "Credit", width: 15, money: true },
  { key: "runningBalance", label: "Balance", width: 16, money: true },
  { key: "runningType", label: "Dr/Cr", width: 8, align: "center" },
];

/**
 * ONE WORKBOOK, TWO SHEETS.
 *
 * A sheet per party does not scale — forty tabs is unreadable and two thousand
 * will not open. So the pack is normalised: "Summary" is one row per party
 * with its opening, movement and closing; "Transactions" is one row per
 * posting with the party's code and name on it, which is the shape a
 * spreadsheet can filter, pivot and total.
 *
 * The opening balance is a ROW in Transactions too, per party, so the running
 * balance column can be read down a party's block without cross-referencing
 * the other sheet.
 */
function buildStatementPackWorkbook(pack) {
  const wb = newWorkbook();
  const L = pack.labels || {};
  const headerRowIdx = 7;

  /* ── Sheet 1: one row per party ───────────────────────────────────────── */
  const cols = PACK_SUMMARY_COLUMNS.map((c) =>
    c.key === "name" ? { ...c, label: L.column || "Party" } : c,
  );
  const lastCol = String.fromCharCode(64 + cols.length);
  const ws = wb.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: headerRowIdx, xSplit: 2 }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = cols.map((c) => ({ width: c.width }));
  writeSheetHeader(ws, {
    company: pack.company,
    title: pack.title,
    period: packPeriodLabel(pack),
    filters: pack.scopeSummary,
    lastCol,
  });
  writeTableHeader(
    ws,
    headerRowIdx,
    cols.map((c) => ({ label: c.label, align: c.align || (c.money || c.int ? "right" : "left") })),
  );

  pack.statements.forEach((s, i) => {
    const flat = {
      code: s.ledger.code,
      name: s.ledger.name,
      gstin: s.ledger.gstin,
      openingBalance: s.opening.amount,
      openingType: s.opening.type,
      debit: s.totals.debit,
      credit: s.totals.credit,
      closingBalance: s.closing.amount,
      closingType: s.closing.type,
      transactionCount: s.totals.transactionCount,
    };
    const row = ws.getRow(headerRowIdx + 1 + i);
    cols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.money || c.int) {
        cell.value = Number(flat[c.key] || 0);
        cell.numFmt = c.money ? MONEY_FMT : INT_FMT;
      } else {
        cell.value = flat[c.key] == null ? "" : String(flat[c.key]);
      }
      cell.alignment = { horizontal: c.align || (c.money || c.int ? "right" : "left"), vertical: "middle" };
      cell.font = { name: c.key === "code" ? "Consolas" : "Arial", size: 9 };
    });
    if (i % 2 === 0) {
      for (let c = 1; c <= cols.length; c += 1) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    }
    borderRow(row, cols.length);
    row.height = 18;
  });

  const totalIdx = headerRowIdx + 1 + pack.statements.length;
  const tr = ws.getRow(totalIdx);
  tr.getCell(1).value = "TOTAL";
  tr.getCell(2).value = `${pack.totals.partyCount} ${pack.totals.partyCount === 1 ? L.party || "party" : L.partyPlural || "parties"} · ${pack.totals.transactionCount} transaction${pack.totals.transactionCount === 1 ? "" : "s"}`;
  tr.getCell(6).value = Number(pack.totals.debit);
  tr.getCell(6).numFmt = MONEY_FMT;
  tr.getCell(7).value = Number(pack.totals.credit);
  tr.getCell(7).numFmt = MONEY_FMT;
  tr.getCell(10).value = Number(pack.totals.transactionCount);
  tr.getCell(10).numFmt = INT_FMT;
  for (let c = 1; c <= cols.length; c += 1) {
    tr.getCell(c).font = { name: "Arial", size: 10, bold: true, color: { argb: INK } };
    tr.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
  }
  borderRow(tr, cols.length);
  if (pack.statements.length) {
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + pack.statements.length, column: cols.length },
    };
  }

  /* ── Sheet 2: one row per posting ─────────────────────────────────────── */
  const tcols = PACK_TXN_COLUMNS.map((c) =>
    c.key === "name" ? { ...c, label: L.column || "Party" } : c,
  );
  const tws = wb.addWorksheet("Transactions", {
    views: [{ state: "frozen", ySplit: headerRowIdx }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  tws.columns = tcols.map((c) => ({ width: c.width }));
  writeSheetHeader(tws, {
    company: pack.company,
    title: `${pack.title} — transactions`,
    period: packPeriodLabel(pack),
    filters: pack.scopeSummary,
    lastCol: String.fromCharCode(64 + tcols.length),
  });
  writeTableHeader(
    tws,
    headerRowIdx,
    tcols.map((c) => ({ label: c.label, align: c.align || (c.money ? "right" : "left") })),
  );

  let r = headerRowIdx + 1;
  for (const s of pack.statements) {
    /* The opening as a row, so a party's block reads top to bottom without
     * looking anything up on the other sheet. */
    const openRow = tws.getRow(r);
    openRow.getCell(1).value = s.ledger.code;
    openRow.getCell(2).value = s.ledger.name;
    openRow.getCell(6).value = "Opening Balance";
    openRow.getCell(9).value = Number(s.opening.amount);
    openRow.getCell(9).numFmt = MONEY_FMT;
    openRow.getCell(10).value = s.opening.type;
    for (let c = 1; c <= tcols.length; c += 1) {
      openRow.getCell(c).font = { name: "Arial", size: 9, bold: true, color: { argb: INK } };
      openRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
    }
    borderRow(openRow, tcols.length);
    r += 1;

    for (const t of s.rows) {
      const flat = { code: s.ledger.code, name: s.ledger.name, ...t };
      const row = tws.getRow(r);
      tcols.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        if (c.date) cell.value = fmtDate(flat[c.key]);
        else if (c.money) {
          cell.value = Number(flat[c.key] || 0);
          cell.numFmt = MONEY_FMT;
        } else cell.value = flat[c.key] == null ? "" : String(flat[c.key]);
        cell.alignment = { horizontal: c.align || (c.money ? "right" : "left"), vertical: "middle" };
        cell.font = { name: "Arial", size: 9 };
      });
      borderRow(row, tcols.length);
      r += 1;
    }

    const closeRow = tws.getRow(r);
    closeRow.getCell(1).value = s.ledger.code;
    closeRow.getCell(2).value = s.ledger.name;
    closeRow.getCell(6).value = "Closing Balance";
    closeRow.getCell(7).value = Number(s.totals.debit);
    closeRow.getCell(7).numFmt = MONEY_FMT;
    closeRow.getCell(8).value = Number(s.totals.credit);
    closeRow.getCell(8).numFmt = MONEY_FMT;
    closeRow.getCell(9).value = Number(s.closing.amount);
    closeRow.getCell(9).numFmt = MONEY_FMT;
    closeRow.getCell(10).value = s.closing.type;
    for (let c = 1; c <= tcols.length; c += 1) {
      closeRow.getCell(c).font = { name: "Arial", size: 9, bold: true, color: { argb: INK } };
      closeRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    }
    borderRow(closeRow, tcols.length);
    r += 1;
  }

  return wb;
}

/**
 * One PDF, each party starting on a NEW PAGE.
 *
 * A combined statement is sent to an auditor, not to a party, so it is one
 * document — but every party still begins on its own page so a single
 * statement can be printed or detached without carrying half of somebody
 * else's on the back of it.
 */
function writeStatementPackPdf(pack, stream) {
  const { w: pw, h: ph } = A4.landscape;
  const pageWidth = pw - MARGIN * 2;
  const doc = newDoc("landscape");
  doc.pipe(stream);

  if (!pack.statements.length) {
    drawPageHead(
      doc,
      {
        company: pack.company,
        title: pack.title,
        period: packPeriodLabel(pack),
        filters: pack.scopeSummary,
      },
      pageWidth,
    );
    doc.fontSize(9).font("Helvetica").fillColor(PDF_MUTED);
    cellText(
      doc,
      "No parties matched this scope — nothing to state.",
      MARGIN,
      MARGIN + 80,
      pageWidth,
    );
    stampFooters(doc, { pageWidth, pageHeight: ph, note: pack.scopeSummary });
    doc.end();
    return doc;
  }

  pack.statements.forEach((s, index) => {
    // Every party after the first opens a page of its own.
    if (index > 0) doc.addPage();
    drawOneStatement(doc, pack, s, pageWidth, ph);
  });

  stampFooters(doc, {
    pageWidth,
    pageHeight: ph,
    note: `${(pack.company && pack.company.companyName) || ""} · ${pack.totals.partyCount} ${(pack.labels && pack.labels.partyPlural) || "parties"}`,
  });
  doc.end();
  return doc;
}

/**
 * One party's statement, drawn from the current y on the current page.
 *
 * Shared by the combined PDF and the per-party PDFs in the ZIP, so the two
 * cannot drift into showing different things for the same party.
 */
function drawOneStatement(doc, pack, s, pageWidth, pageHeight) {
  const columns = layoutColumns(
    [
      { key: "date", label: "Date", w: 62 },
      { key: "voucherType", label: "Voucher Type", w: 84 },
      { key: "voucherNumber", label: "Voucher No.", w: 90 },
      { key: "narration", label: "Narration", w: 210 },
      { key: "debit", label: "Debit", w: 84, align: "right" },
      { key: "credit", label: "Credit", w: 84, align: "right" },
      { key: "runningBalance", label: "Balance", w: 90, align: "right" },
      { key: "runningType", label: "Dr/Cr", w: 36, align: "center" },
    ],
    pageWidth,
  );
  const c = (k) => columns.find((x) => x.key === k);

  const head = {
    company: pack.company,
    title: `${(pack.labels && pack.labels.statementTitle) || "Statement of Account"} — ${s.ledger.name}`,
    period: `${packPeriodLabel(pack)} · Code ${s.ledger.code}${s.ledger.gstin ? ` · GSTIN ${s.ledger.gstin}` : ""}`,
    filters: pack.scopeSummary,
  };

  let y = drawPageHead(doc, head, pageWidth);
  y = drawTableHeader(doc, columns, y, pageWidth);

  const ROW_H = 15;
  const bottom = pageHeight - MARGIN - 16;
  const newPage = () => {
    doc.addPage();
    return drawTableHeader(doc, columns, drawPageHead(doc, head, pageWidth), pageWidth);
  };

  const band = (label, amount, type, atY) => {
    doc.rect(MARGIN, atY, pageWidth, 17).fill(type === "Cr" ? "#ecfdf5" : "#eef2ff");
    doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
    cellText(doc, label, c("narration").x + 3, atY + 5, c("narration").w - 6);
    doc.font("Courier-Bold").fillColor(type === "Cr" ? PDF_CREDIT : PDF_DEBIT);
    cellText(doc, fmtMoney(amount), c("runningBalance").x + 3, atY + 5, c("runningBalance").w - 6, {
      align: "right",
    });
    doc.font("Helvetica-Bold");
    cellText(doc, type, c("runningType").x + 3, atY + 5, c("runningType").w - 6, {
      align: "center",
    });
    return atY + 17;
  };

  y = band("Opening Balance", s.opening.amount, s.opening.type, y);

  s.rows.forEach((t, i) => {
    if (y + ROW_H > bottom) y = newPage();
    if (i % 2 === 0) doc.rect(MARGIN, y, pageWidth, ROW_H).fill(PDF_BAND);
    doc.fontSize(7).font("Helvetica").fillColor(PDF_INK);
    cellText(doc, fmtDate(t.date), c("date").x + 3, y + 4, c("date").w - 6);
    cellText(doc, t.voucherType, c("voucherType").x + 3, y + 4, c("voucherType").w - 6);
    doc.font("Courier").fillColor(PDF_BRAND);
    cellText(doc, t.voucherNumber || "—", c("voucherNumber").x + 3, y + 4, c("voucherNumber").w - 6);
    doc.fontSize(6.5).font("Helvetica").fillColor(PDF_MUTED);
    cellText(doc, t.narration || t.counterParty || "—", c("narration").x + 3, y + 4.5, c("narration").w - 6);
    doc.fontSize(7).font("Courier").fillColor(t.debit ? PDF_DEBIT : PDF_FAINT);
    cellText(doc, t.debit ? fmtMoney(t.debit) : "—", c("debit").x + 3, y + 4, c("debit").w - 6, { align: "right" });
    doc.fillColor(t.credit ? PDF_CREDIT : PDF_FAINT);
    cellText(doc, t.credit ? fmtMoney(t.credit) : "—", c("credit").x + 3, y + 4, c("credit").w - 6, { align: "right" });
    doc.font("Courier-Bold").fillColor(PDF_INK);
    cellText(doc, fmtMoney(t.runningBalance), c("runningBalance").x + 3, y + 4, c("runningBalance").w - 6, { align: "right" });
    doc.font("Helvetica-Bold").fillColor(t.runningType === "Cr" ? PDF_CREDIT : PDF_DEBIT);
    cellText(doc, t.runningType, c("runningType").x + 3, y + 4, c("runningType").w - 6, { align: "center" });
    y += ROW_H;
  });

  if (y + 40 > bottom) y = newPage();
  doc.rect(MARGIN, y, pageWidth, 17).fill("#f1f5f9");
  doc.fontSize(8).font("Helvetica-Bold").fillColor(PDF_INK);
  cellText(
    doc,
    `Total movement · ${s.totals.transactionCount} voucher${s.totals.transactionCount === 1 ? "" : "s"}`,
    c("narration").x + 3,
    y + 5,
    c("narration").w - 6,
  );
  doc.font("Courier-Bold").fillColor(PDF_DEBIT);
  cellText(doc, fmtMoney(s.totals.debit), c("debit").x + 3, y + 5, c("debit").w - 6, { align: "right" });
  doc.fillColor(PDF_CREDIT);
  cellText(doc, fmtMoney(s.totals.credit), c("credit").x + 3, y + 5, c("credit").w - 6, { align: "right" });
  y += 17;
  band("Closing Balance", s.closing.amount, s.closing.type, y);
}

/**
 * The manifest that ships inside the ZIP.
 *
 * A folder of forty PDFs is not a deliverable on its own — somebody has to be
 * able to check that what arrived is what was asked for, without opening every
 * file. So the archive carries a CSV listing party, code, period, opening and
 * closing balances and the filename each landed under. It is generated from
 * the same list the entries are, so the two cannot disagree.
 */
function packManifestCsv(pack, filenames) {
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const period = pack.from
    ? `${isoDay(pack.from)} to ${isoDay(pack.periodEnd || pack.generatedAt)}`
    : `as on ${isoDay(pack.periodEnd || pack.generatedAt)}`;
  const lines = [
    [
      "Company",
      "Party Code",
      "Party Name",
      "GSTIN",
      "Period",
      "Opening Balance",
      "Opening Dr/Cr",
      "Closing Balance",
      "Closing Dr/Cr",
      "Debit",
      "Credit",
      "Transactions",
      "Filename",
    ].map(esc).join(","),
  ];
  pack.statements.forEach((s, i) => {
    lines.push(
      [
        pack.company.companyName,
        s.ledger.code,
        s.ledger.name,
        s.ledger.gstin || "",
        period,
        s.opening.amount,
        s.opening.type,
        s.closing.amount,
        s.closing.type,
        s.totals.debit,
        s.totals.credit,
        s.totals.transactionCount,
        filenames[i],
      ].map(esc).join(","),
    );
  });
  return `${lines.join("\n")}\n`;
}

/**
 * ONE PDF PER PARTY, PLUS THE MANIFEST, IN A ZIP.
 *
 * Each entry is a complete standalone statement — the same `drawOneStatement`
 * the combined PDF uses — because these are the files that actually get sent
 * to a customer or supplier, one at a time.
 *
 * Entries are appended as streams and `archiver` consumes them one at a time,
 * so the archive itself is never assembled in memory. Each PDF still buffers
 * its own bytes until its turn comes — pdfkit does not pause for backpressure
 * — which is why the party cap is enforced before any of this runs.
 */
function writeStatementPackZip(pack, stream) {
  const archiver = require("archiver");
  const { w: pw, h: ph } = A4.landscape;
  const pageWidth = pw - MARGIN * 2;

  const archive = archiver("zip", { zlib: { level: 9 } });
  /* An unhandled "error" on an EventEmitter throws out of the event loop and
   * takes the process with it. By the time an archive can fail the response
   * headers are long sent, so there is no status code left to change — the
   * honest end is a truncated download, logged, rather than a dead server. */
  archive.on("error", (e) => {
    console.error("[accountingExport/writeStatementPackZip]", e);
    if (typeof stream.destroy === "function") stream.destroy(e);
    else stream.end();
  });
  archive.pipe(stream);

  const filenames = packFilenames(pack, "pdf");
  archive.append(Buffer.from(packManifestCsv(pack, filenames), "utf8"), {
    name: "manifest.csv",
  });

  pack.statements.forEach((s, i) => {
    const doc = newDoc("landscape");
    /* `archiver` reads the stream lazily, so the document is handed over
     * before it is finished and drains as the archive consumes it. */
    archive.append(doc, { name: filenames[i] });
    drawOneStatement(doc, pack, s, pageWidth, ph);
    stampFooters(doc, {
      pageWidth,
      pageHeight: ph,
      note: `${(pack.company && pack.company.companyName) || ""} · ${s.ledger.name}`,
    });
    doc.end();
  });

  archive.finalize();
  return archive;
}

const ZIP_CONTENT_TYPE = "application/zip";

module.exports = {
  // Constants + formatting (exported for tests and for a future supplier
  // report that must look identical)
  MONEY_FMT,
  INT_FMT,
  XLSX_CONTENT_TYPE,
  PDF_CONTENT_TYPE,
  OUTSTANDING_COLUMNS,
  outstandingColumns,
  STATEMENT_COLUMNS,
  totalsNarrative,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  isoDay,
  safeFilename,
  setDownloadHeaders,
  outstandingFilename,
  statementFilename,
  periodLabel,
  openingNote,
  layoutColumns,

  // Writers
  buildOutstandingWorkbook,
  buildStatementWorkbook,
  writeOutstandingPdf,
  writeStatementPdf,
  buildAgeingWorkbook,
  writeAgeingPdf,
  buildStatementPackWorkbook,
  writeStatementPackPdf,
  writeStatementPackZip,
  packFilenames,
  packFilename,
  packManifestCsv,
  packPeriodLabel,
  packPeriodSlug,
  ZIP_CONTENT_TYPE,
  PACK_SUMMARY_COLUMNS,
  PACK_TXN_COLUMNS,
  AGEING_PARTY_COLUMNS,
  AGEING_INVOICE_COLUMNS,
  ageingPartyColumns,
  ageingInvoiceColumns,
  DUE_SOURCE_LABEL,
  dueSourceLabels,
};
