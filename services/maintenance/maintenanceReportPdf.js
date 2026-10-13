// services/maintenance/maintenanceReportPdf.js
//
// THE MAINTENANCE REPORT AS A PDF (owner, 4 Oct 2026: "after each maintenance
// job is completed, generate a downloadable PDF Maintenance Report for that
// specific job — not a software-only page"). The PDF IS the report people
// keep, print, sign and file.
//
// It is drawn from the report as stored — written once when its job was
// closed and never changed (MaintenanceOrder's write-once guard) — so the
// same report always gives the same document, today or in five years. It
// reads nothing else: no live machine name, no current status.
//
// The owner's structure (4 Oct 2026), A4, one column:
//   Header      GRAV CLOTHING — Maintenance Report; report no., order no., status
//   1 Asset     name, ID, barcode, type, make/model, serial no., department, location
//   2 Maintenance  type, reported problem, root cause, work performed,
//               solution, parts used
//   3 Time      reported, repair start, repair completion, total downtime,
//               actual repair time (the maintenance duration)
//   4 People    reported by, technician, checked / approved by
//   5 Outcome   final machine status, test result, next date, recommendations
//   6 Evidence  before / after photos (embedded), every attachment
//   7 Audit     created, completed, approved, report number, revision status
// then two signature lines, and a footer on every page. "Not recorded" is
// printed only for an optional fact or a report filed for a legacy job; the
// required ones cannot be missing from a submitted report (reportFrom). pdfkit's own Helvetica covers Latin text; a Unicode font is
// used instead when the host has one, so a name typed in another script is
// not turned into question marks.
"use strict";

const fs = require("fs");
const PDFDocument = require("pdfkit");

const PAGE = { w: 595.28, h: 841.89 };
const M = 44;
const W = PAGE.w - M * 2;
const INK = "#111111";
const MUTED = "#5b6168";
const FAINT = "#8a9097";
const RULE = "#d9dce0";
const BAND = "#f2f3f5";
const TONE = { operational: "#3f7a58", monitor: "#9a6b2f", limited: "#9a6b2f", "not-repaired": "#9a3f3f", "out-of-service": "#9a3f3f", unrecorded: "#6f8296" };

/* A Unicode font when the host has one (Windows: Arial; Linux: DejaVu / Noto). */
const FONT_CANDIDATES = [
  ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
  ["/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"],
];
function pickFonts() {
  for (const [regular, bold] of FONT_CANDIDATES) {
    try { if (fs.existsSync(regular) && fs.existsSync(bold)) return { regular, bold, unicode: true }; } catch { /* next */ }
  }
  return { regular: "Helvetica", bold: "Helvetica-Bold", unicode: false };
}

/* Helvetica speaks Windows-1252 only: anything else becomes "?" rather than
   garbage, and the arrows and dashes we write ourselves stay readable. */
function safeText(s, unicode) {
  const t = String(s ?? "");
  if (unicode) return t;
  return t.replace(/→/g, "->").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2022\u2026\u20ac]/g, "?");
}

const IST = { timeZone: "Asia/Kolkata" };
const clock = (d) => (d ? new Date(d).toLocaleString("en-IN", { ...IST, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "");
const dayOnly = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short", year: "numeric" }) : "");
/* "2 Days 4 Hrs", "1 Hr 25 Min" — the screens' own wording (orderFlow.mjs). */
function duration(minutes) {
  if (!Number.isFinite(minutes)) return "";
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mi = m % 60;
  const p = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (d) return h ? `${p(d, "Day")} ${p(h, "Hr")}` : p(d, "Day");
  if (h) return mi ? `${p(h, "Hr")} ${mi} Min` : p(h, "Hr");
  return `${mi} Min`;
}
const fileSize = (n) => (!Number.isFinite(n) ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** The file name a person saves: MR-0001_MSO-0001_SNLS1.pdf */
function pdfFileName(r) {
  const part = (s) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return [part(r.reportNumber), part(r.orderNumber), part(r.subject?.kind !== "none" ? r.subject?.name : r.title)].filter(Boolean).join("_") + ".pdf";
}

/**
 * The PDF of one report (`reportView` from maintenanceOrders.service), as a
 * Buffer. `company` is the name printed in the header.
 */
function buildReportPdf(r, { company = "GRAV Clothing", images = { before: [], after: [] } } = {}) {
  const fonts = pickFonts();
  const T = (s) => safeText(s, fonts.unicode);
  const doc = new PDFDocument({
    size: "A4", margins: { top: M, bottom: M + 24, left: M, right: M }, bufferPages: true,
    info: { Title: `Maintenance Report ${r.reportNumber}`, Subject: `${r.orderNumber} — ${r.subject?.name || r.title || ""}`, Author: company, Creator: "GRAV CMS · Maintenance", CreationDate: new Date(r.submittedAt || Date.now()) },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  doc.registerFont("R", fonts.regular);
  doc.registerFont("B", fonts.bold);

  const bottom = () => PAGE.h - M - 24;
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  /* ── Header ── */
  const fs_ = r.finalStatus || "unrecorded";
  doc.rect(0, 0, PAGE.w, 96).fill("#1f1f1f");
  doc.font("R").fontSize(9).fillColor("#c9ccd1").text(T(company.toUpperCase()), M, 26, { width: W / 2, characterSpacing: 1 });
  doc.font("B").fontSize(20).fillColor("#ffffff").text("Maintenance Report", M, 40, { width: W / 2 });
  doc.font("R").fontSize(9.5).fillColor("#c9ccd1").text(T(`Maintenance Order ${r.orderNumber} · ${r.orderType === "product" ? "Product Maintenance" : "Service Maintenance"}`), M, 66, { width: W / 2 });
  doc.font("B").fontSize(22).fillColor("#ffffff").text(T(r.reportNumber), M + W / 2, 30, { width: W / 2, align: "right" });
  /* Two states: what the machine was left as, and where the report stands. */
  const pill = (label, color, right) => {
    doc.font("B").fontSize(9);
    const w = doc.widthOfString(label) + 18;
    doc.roundedRect(right - w, 64, w, 18, 9).fill(color);
    doc.fillColor("#ffffff").text(label, right - w, 68.5, { width: w, align: "center" });
    return right - w - 6;
  };
  const next = pill(T(`Machine: ${r.finalStatusLabel || "Not recorded"}`), TONE[fs_] || TONE.unrecorded, M + W);
  pill(r.approvedAt ? "Report: Approved" : "Report: Awaiting approval", r.approvedAt ? "#3f7a58" : "#6f8296", next);
  doc.y = 112;

  if (r.source === "backfill") {
    doc.roundedRect(M, doc.y, W, 34, 6).fill("#eef1f5");
    doc.font("R").fontSize(8.5).fillColor(MUTED).text(T("Filed for a job closed before reports existed: the diagnosis, work performed and parts are what was written when the repair was done; the final status and solution were never recorded and say so instead of guessing."), M + 10, doc.y + 7, { width: W - 20 });
    doc.y += 44;
  }

  /* ── A section heading, and label/value rows two to a line ── */
  let n = 0;
  const section = (title) => {
    room(60);
    n += 1;
    doc.moveDown(0.2);
    const y = doc.y;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
    doc.font("B").fontSize(8.5).fillColor(FAINT).text(T(`${n}. ${title.toUpperCase()}`), M, y + 7, { width: W, characterSpacing: 0.8 });
    doc.y = y + 21;
  };
  const value = (v) => (v === null || v === undefined || v === "" ? null : String(v));
  const grid = (rows) => {
    const shown = rows.map(([k, v, wide]) => [k, value(v), wide]);
    const colW = (W - 16) / 2;
    let i = 0;
    while (i < shown.length) {
      const [k, v, wide] = shown[i];
      if (wide) {
        doc.font("R").fontSize(10.5);
        const h = doc.heightOfString(T(v || "Not recorded"), { width: W }) + 16;
        room(h);
        const y = doc.y;
        doc.font("R").fontSize(8).fillColor(FAINT).text(T(k), M, y, { width: W });
        doc.font("R").fontSize(10.5).fillColor(v ? INK : FAINT).text(T(v || "Not recorded"), M, y + 11, { width: W });
        doc.y = Math.max(doc.y, y + h) + 2;
        i += 1;
        continue;
      }
      const pair = [shown[i], shown[i + 1] && !shown[i + 1][2] ? shown[i + 1] : null];
      doc.font("R").fontSize(10.5);
      const hs = pair.filter(Boolean).map(([, pv]) => doc.heightOfString(T(pv || "Not recorded"), { width: colW }));
      const h = Math.max(...hs) + 16;
      room(h);
      const y = doc.y;
      pair.forEach((p, j) => {
        if (!p) return;
        const x = M + j * (colW + 16);
        doc.font("R").fontSize(8).fillColor(FAINT).text(T(p[0]), x, y, { width: colW });
        doc.font("R").fontSize(10.5).fillColor(p[1] ? INK : FAINT).text(T(p[1] || "Not recorded"), x, y + 11, { width: colW });
      });
      doc.y = y + h + 2;
      i += pair[1] ? 2 : 1;
    }
  };

  const a = r.asset || {};
  const freeForm = r.subject?.kind === "none";
  const notRecorded = (v) => v || null;

  section(freeForm ? "Asset details (service)" : "Asset details");
  grid([
    [freeForm ? "Equipment / service" : "Machine name", a.name || r.title],
    [freeForm ? "Asset / equipment ID" : "Machine ID", a.code],
    ["Barcode", notRecorded(a.barcode)],
    [freeForm ? "Category" : "Machine type", a.type],
    ["Make / model", notRecorded(a.makeModel)],
    ["Serial No.", notRecorded(a.serialNumber)],
    ["Department", notRecorded(a.department)],
    ["Location", notRecorded(a.location)],
  ]);

  section("Maintenance details");
  grid([
    ["Maintenance type", r.maintenanceTypeLabel],
    ["Reported problem", r.problem, true],
    ["Diagnosis / root cause", r.rootCause, true],
    ["Work performed", r.workPerformed, true],
    ["Solution / resolution", r.resolution, true],
  ]);
  /* Parts used, as a table. */
  room(40);
  doc.font("R").fontSize(8).fillColor(FAINT).text("Parts used", M, doc.y);
  doc.moveDown(0.3);
  if (r.partsUsed?.length) {
    const qx = M + W - 120;
    doc.rect(M, doc.y, W, 16).fill(BAND);
    doc.font("B").fontSize(8.5).fillColor(MUTED).text("Part", M + 8, doc.y + 4.5, { width: W - 140 });
    doc.text("Quantity", qx, doc.y - 10.5, { width: 112, align: "right" });
    doc.y += 6;
    for (const p of r.partsUsed) {
      room(18);
      const y = doc.y;
      doc.font("R").fontSize(10).fillColor(INK).text(T(p.name), M + 8, y, { width: W - 140 });
      doc.text(T(`${p.quantity}${p.unit ? ` ${p.unit}` : ""}`), qx, y, { width: 112, align: "right" });
      doc.y = Math.max(doc.y, y + 14);
      doc.moveTo(M, doc.y + 2).lineTo(M + W, doc.y + 2).lineWidth(0.4).strokeColor(RULE).stroke();
      doc.y += 5;
    }
  } else {
    doc.font("R").fontSize(10.5).fillColor(MUTED).text("No parts used", M, doc.y);
  }
  doc.moveDown(0.6);

  section("Time");
  grid([
    ["Reported", clock(r.reportedAt || r.openedAt)],
    ["Repair start", clock(r.startedAt)],
    ["Repair completion", clock(r.completedAt)],
    ["Total downtime (reported to completion)", duration(r.downtimeMinutes)],
    ["Actual repair time (start to completion)", duration(r.repairMinutes)],
  ]);

  section("People");
  grid([
    ["Reported by", r.reportedBy?.name || r.createdBy?.name],
    ["Maintenance technician", r.technician?.name],
    ["Checked / approved by", r.approvedBy?.name ? `${r.approvedBy.name}${r.approvalNote ? ` — ${r.approvalNote}` : ""}` : "Awaiting approval"],
    ["Report submitted by", r.submittedBy?.name],
  ]);

  section("Outcome");
  grid([
    ["Final machine status", r.finalStatusLabel],
    ["Next maintenance date", notRecorded(dayOnly(r.nextMaintenanceDate))],
    ["Test result", notRecorded(r.testResult), true],
    ["Recommendations", notRecorded(r.recommendations), true],
    ["Remarks / notes", notRecorded(r.remarks), true],
  ]);

  section("Evidence");
  /* Photos are drawn into the PDF; everything else is listed by name. */
  const photoRow = (title, list) => {
    doc.font("B").fontSize(9).fillColor(MUTED).text(title, M, doc.y);
    doc.moveDown(0.3);
    if (!list.length) {
      doc.font("R").fontSize(10).fillColor(FAINT).text("None", M, doc.y);
      doc.moveDown(0.5);
      return;
    }
    const size = (W - 4 * 10) / 5;
    for (let i = 0; i < list.length; i += 5) {
      room(size + 26);
      const y = doc.y;
      list.slice(i, i + 5).forEach((img, j) => {
        const x = M + j * (size + 10);
        try {
          doc.save().rect(x, y, size, size).clip();
          doc.image(img.buffer, x, y, { cover: [size, size], align: "center", valign: "center" });
          doc.restore();
          doc.rect(x, y, size, size).lineWidth(0.5).strokeColor(RULE).stroke();
        } catch {
          doc.restore();
          doc.rect(x, y, size, size).fill(BAND);
          doc.font("R").fontSize(8).fillColor(FAINT).text("Photo could not be drawn", x + 6, y + size / 2 - 5, { width: size - 12, align: "center" });
        }
        doc.font("R").fontSize(7.5).fillColor(MUTED).text(T(img.name), x, y + size + 3, { width: size, lineBreak: false, ellipsis: true });
      });
      doc.y = y + size + 18;
    }
    doc.moveDown(0.3);
  };
  photoRow("Before (with the job, when it was raised)", images.before || []);
  photoRow("After (proof submitted with the report)", images.after || []);
  room(30);
  doc.font("B").fontSize(9).fillColor(MUTED).text("Attachments", M, doc.y);
  doc.moveDown(0.3);
  const files = r.attachments || [];
  if (files.length) {
    const STAGE = { raised: "with the job", proof: "proof with the report", later: "added later" };
    for (const f of files) {
      room(15);
      doc.font("R").fontSize(9.5).fillColor(INK).text(T(`•  ${f.name}  —  ${STAGE[f.stage] || f.stage}${f.size ? `, ${fileSize(f.size)}` : ""}`), M, doc.y, { width: W });
    }
    doc.font("R").fontSize(8).fillColor(FAINT).text("Kept privately on Google Drive with the job; opened from the job in the GRAV CMS.", M, doc.y + 3, { width: W });
  } else {
    doc.font("R").fontSize(10).fillColor(FAINT).text("None", M, doc.y);
  }
  doc.moveDown(0.6);

  section("Audit");
  grid([
    ["Report number", r.reportNumber],
    ["Maintenance order", r.orderNumber],
    ["Created at", clock(r.openedAt)],
    ["Completed at (report submitted)", clock(r.submittedAt)],
    ["Approved at", r.approvedAt ? clock(r.approvedAt) : "Awaiting approval"],
    ["Revision / audit status", r.revision || "Original — never revised"],
  ]);

  /* Signatures — the paper copy is signed and filed. */
  /* The lines, their labels and the gap above them stay together on one page. */
  if (doc.y + 96 > bottom()) doc.addPage();
  const sy = doc.y + 48;
  const half = (W - 40) / 2;
  [["Technician", r.technician?.name], ["Checked / approved by", r.approvedBy?.name || ""]].forEach(([label, name], j) => {
    const x = M + j * (half + 40);
    doc.moveTo(x, sy).lineTo(x + half, sy).lineWidth(0.6).strokeColor("#9aa0a6").stroke();
    doc.font("R").fontSize(8.5).fillColor(MUTED).text(T(name ? `${label} — ${name}` : label), x, sy + 5, { width: half });
  });
  doc.y = sy + 24;

  /* Footer on every page. */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    /* Writing below the bottom margin would make pdfkit start a new page. */
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = PAGE.h - M - 6;
    doc.moveTo(M, fy - 6).lineTo(M + W, fy - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font("R").fontSize(7.5).fillColor(FAINT)
      .text(T(`${r.reportNumber} · ${r.orderNumber} · written once on ${clock(r.submittedAt)} and never changed — this document is generated from that record.`), M, fy, { width: W - 70, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, M + W - 70, fy, { width: 70, align: "right", lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}

/* pdfkit draws JPEG and PNG only. */
const DRAWABLE = /^image\/(jpe?g|png)$/i;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PHOTOS_PER_ROW_MAX = 5;

/**
 * Before / after photos for the Evidence section, read with `readFile`
 * (the Drive reader: `fileId → { stream, meta }`). A photo that cannot be
 * read in time is left out of the drawing — it is still listed under
 * Attachments — so a slow Drive never stops the PDF.
 */
async function evidenceImages(report, readFile, { timeoutMs = 8000 } = {}) {
  const pick = (stages) => (report.attachments || []).filter((a) => stages.includes(a.stage) && DRAWABLE.test(a.mimeType || "")).slice(0, PHOTOS_PER_ROW_MAX);
  const read = async (a) => {
    if (Number.isFinite(a.size) && a.size > PHOTO_MAX_BYTES) return null;
    const work = (async () => {
      const { stream } = await readFile(a.fileId);
      const chunks = [];
      let n = 0;
      for await (const c of stream) { n += c.length; if (n > PHOTO_MAX_BYTES) return null; chunks.push(c); }
      return { name: a.name, buffer: Buffer.concat(chunks) };
    })();
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    return Promise.race([work, timer]).catch(() => null);
  };
  const [before, after] = await Promise.all([
    Promise.all(pick(["raised", "later"]).map(read)),
    Promise.all(pick(["proof"]).map(read)),
  ]);
  return { before: before.filter(Boolean), after: after.filter(Boolean) };
}

module.exports = { buildReportPdf, evidenceImages, pdfFileName, safeText, duration };
