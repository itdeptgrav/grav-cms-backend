// services/mail/documentPdf.js
//
// ONE PDF SHAPE FOR THE DOCUMENTS A MAIL ATTACHES  (10 Oct 2026, owner)
//
// A material request, a purchase order and a goods receipt are the same thing
// on paper: a letterhead, a title, a block of facts, one or more tables, a
// note. One builder draws all of them, so the three attachments the owner
// asked for ("attach a pdf in order to describe that data completely") read
// alike and cannot drift. pdfkit, like manufacturingOrderPdf.js; resolves to
// a Buffer; never throws past the caller's try — a failed PDF costs the
// attachment, not the mail.
//
//   buildDocumentPdf({
//     title, subtitle, reference,              // "Material request", "MR-REQ-…-01"
//     facts: [[label, value], …],              // two-column block
//     sections: [{ heading, columns: [{ key, label, align, width }], rows: [{…}], note }],
//     notes: "…", footer: "…",
//   }) → Promise<Buffer>
"use strict";

const PDFDocument = require("pdfkit");

const MARGIN = 40;
const INK = "#0f172a", MUTED = "#64748b", RULE = "#e2e8f0", HEAD_BG = "#f1f5f9";

async function letterhead() {
  try {
    const StoreSettings = require("../../models/CMS_Models/Inventory/Operations/StoreSettings");
    const s = await StoreSettings.get("store");
    return s || null;
  } catch { return null; }
}

const str = (v) => (v === null || v === undefined ? "" : String(v));

/**
 * @returns {Promise<Buffer>}
 */
async function buildDocumentPdf({ title = "Document", subtitle = "", reference = "", facts = [], sections = [], notes = "", footer = "" } = {}) {
  const head = await letterhead();
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: `${title} ${reference}`.trim(), Author: "GRAV Clothing" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - MARGIN * 2;
  let y = MARGIN;
  const ensure = (h) => { if (y + h > doc.page.height - MARGIN - 24) { doc.addPage(); y = MARGIN; } };

  // ── Letterhead ────────────────────────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text(head?.companyName || "GRAV Clothing", MARGIN, y, { width: W });
  y = doc.y + 2;
  const addr = [head?.addressLine1, head?.addressLine2, [head?.city, head?.state, head?.pincode].filter(Boolean).join(", "), head?.phone ? `Ph: ${head.phone}` : "", head?.gstin ? `GSTIN: ${head.gstin}` : ""].map(str).filter((s) => s.trim());
  if (addr.length) { doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(addr.join("  ·  "), MARGIN, y, { width: W }); y = doc.y + 6; }
  doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).strokeColor(RULE).lineWidth(0.8).stroke(); y += 12;

  // ── Title ─────────────────────────────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(title, MARGIN, y, { width: W * 0.65 });
  if (reference) doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(reference, MARGIN + W * 0.65, y + 4, { width: W * 0.35, align: "right" });
  y = doc.y + 2;
  if (subtitle) { doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(subtitle, MARGIN, y, { width: W }); y = doc.y + 4; }
  y += 8;

  // ── Facts, two columns ────────────────────────────────────────────────
  const rows = (facts || []).filter((f) => f && f[1] !== undefined && f[1] !== null && str(f[1]).trim() !== "");
  if (rows.length) {
    const colW = W / 2, labelW = 92;
    const half = Math.ceil(rows.length / 2);
    const left = rows.slice(0, half), right = rows.slice(half);
    const startY = y;
    let ly = y, ry = y;
    for (const [label, value] of left) {
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(str(label).toUpperCase(), MARGIN, ly, { width: labelW });
      doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(str(value), MARGIN + labelW, ly, { width: colW - labelW - 10 });
      ly = Math.max(doc.y, ly + 12) + 4;
    }
    for (const [label, value] of right) {
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(str(label).toUpperCase(), MARGIN + colW, ry, { width: labelW });
      doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(str(value), MARGIN + colW + labelW, ry, { width: colW - labelW });
      ry = Math.max(doc.y, ry + 12) + 4;
    }
    y = Math.max(ly, ry, startY) + 6;
  }

  // ── Sections ──────────────────────────────────────────────────────────
  for (const sec of sections || []) {
    const cols = (sec.columns || []).filter(Boolean);
    if (!cols.length) continue;
    ensure(40);
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(sec.heading || "", MARGIN, y, { width: W });
    y = doc.y + 4;
    const totalW = cols.reduce((n, c) => n + (c.width || 1), 0);
    const widths = cols.map((c) => Math.floor(W * (c.width || 1) / totalW));
    const drawHead = () => {
      doc.rect(MARGIN, y, W, 16).fill(HEAD_BG);
      let x = MARGIN;
      cols.forEach((c, i) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(str(c.label).toUpperCase(), x + 4, y + 4, { width: widths[i] - 8, align: c.align || "left" });
        x += widths[i];
      });
      y += 16;
    };
    drawHead();
    for (const row of sec.rows || []) {
      // measure the tallest cell first so the row never splits over a page
      doc.font("Helvetica").fontSize(8.5);
      const heights = cols.map((c, i) => doc.heightOfString(str(row[c.key] ?? ""), { width: widths[i] - 8 }));
      const h = Math.max(14, ...heights) + 6;
      if (y + h > doc.page.height - MARGIN - 24) { doc.addPage(); y = MARGIN; drawHead(); }
      let x = MARGIN;
      cols.forEach((c, i) => {
        doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(INK)
          .text(str(row[c.key] ?? ""), x + 4, y + 3, { width: widths[i] - 8, align: c.align || "left" });
        x += widths[i];
      });
      y += h;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).strokeColor(RULE).lineWidth(0.5).stroke();
    }
    if (!(sec.rows || []).length) { doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text("Nothing to list.", MARGIN + 4, y + 4); y = doc.y + 4; }
    if (sec.note) { ensure(20); doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(str(sec.note), MARGIN, y + 6, { width: W }); y = doc.y + 4; }
    y += 10;
  }

  if (notes) { ensure(30); doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Notes", MARGIN, y); y = doc.y + 2; doc.font("Helvetica").fontSize(9).fillColor(INK).text(str(notes), MARGIN, y, { width: W }); y = doc.y + 8; }

  // ── Footer on every page ──────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
      .text(`${footer || "Generated by GRAV Manufacturing Suite"} · ${new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} · page ${i - range.start + 1} of ${range.count}`,
        MARGIN, doc.page.height - MARGIN + 6, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { buildDocumentPdf };
