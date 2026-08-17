// services/costingTotals.js
//
// Cost per piece, and the floor price, computed ON THE SERVER.
//
// WHY THIS EXISTS. The floor price used to be worked out in the browser —
// `cost / (1 - floor%)` inside CostingPanel — which meant the cost had to be on
// the wire for the floor to be displayable. Gating the columns in React while
// the endpoint still served the workbook was theatre: anyone could read the
// vendor prices out of the network tab.
//
// So the sensitive part is reduced here and only the RESULT crosses the wire.
// A salesperson without commercial access gets `{ costed: true, floorPrice }` —
// one number with no structure behind it. No vendor, no unit cost, no SAM, no
// cost per minute, and no cost per piece either.
//
// FORMULAS ARE NOT EVALUATED. The workbook's total cells hold `=SUM(G6:G16)` and
// `=E6*F6`, not numbers — CoWork's client computes those. So this reads the raw
// inputs and does the same arithmetic the front end does
// (lib/salesJourney/costingModel's costTotals), which needs no formula engine
// and cannot disagree with what the costing panel shows.
"use strict";

/** The six categories services/sheetTemplates.js lays out, in its order. */
const RAW_CATEGORIES = ["Fabric", "Thread", "Button", "Fusing", "Trims & Accessory", "Packing Materials"];

const colLetter = (index) => {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
};
const A = (col, row) => `${colLetter(col)}${row + 1}`;

function parseRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref || "").trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const sheetByName = (workbook, name) =>
  (workbook?.sheets || []).find((s) => s.name === name)
  || (workbook?.sheets || []).find((s) => (s.name || "").toLowerCase().includes(name.toLowerCase()))
  || null;

const cell = (sheet, col, row) => sheet?.cells?.[A(col, row)] ?? "";

function findRows(sheet, col, text) {
  const want = String(text).trim().toLowerCase();
  const out = [];
  for (const [ref, value] of Object.entries(sheet?.cells || {})) {
    const at = parseRef(ref);
    if (!at || at.col !== col) continue;
    if (String(value ?? "").trim().toLowerCase() === want) out.push(at.row);
  }
  return out.sort((a, b) => a - b);
}

/**
 * One workbook → its own contribution to cost per piece.
 *
 * Mirrors the client reader exactly, including anchoring on label text rather
 * than fixed rows (the spec block above the table varies in height) and only
 * accepting category marks BELOW the table header, so a spec value reading
 * "Fabric" cannot register as a category.
 */
function totalsFromWorkbook(workbook) {
  const raw = sheetByName(workbook, "Raw Items Detail");
  const summary = sheetByName(workbook, "Inquiry Costing");

  let materials = 0;
  if (raw) {
    const tableTop = findRows(raw, 2, "Raw item")[0] ?? -1;
    const marks = [];
    for (const category of RAW_CATEGORIES) {
      for (const row of findRows(raw, 1, category)) if (row > tableTop) marks.push(row);
    }
    const totalRow = findRows(raw, 1, "Total Raw Material Cost")[0] ?? Infinity;
    marks.sort((a, b) => a - b);
    marks.forEach((markRow, i) => {
      const end = Math.min(marks[i + 1] ?? Infinity, totalRow);
      for (let row = markRow + 1; row < end; row += 1) {
        materials += num(cell(raw, 4, row)) * num(cell(raw, 5, row));
      }
    });
  }

  let operations = 0;
  if (summary) {
    const header = findRows(summary, 0, "Sl")[0];
    const end = Math.min(
      findRows(summary, 0, "Total FOB Cost")[0] ?? Infinity,
      findRows(summary, 0, "Total Operation Cost")[0] ?? Infinity,
    );
    if (header != null) {
      for (let row = header + 1; row < end; row += 1) {
        operations += num(cell(summary, 2, row)) * num(cell(summary, 3, row));
      }
    }
  }

  return { materials, operations };
}

/**
 * Every part of a product's costing → cost per piece and the floor.
 *
 * @param {object[]} workbooks one per contributor sheet (raw / operations / combined)
 * @param {number} floorPercent the margin policy, e.g. 22
 */
function costingTotals(workbooks = [], floorPercent = 22) {
  let materials = 0;
  let operations = 0;
  for (const wb of workbooks) {
    if (!wb) continue;
    const t = totalsFromWorkbook(wb);
    materials += t.materials;
    operations += t.operations;
  }
  const costPerPiece = +(materials + operations).toFixed(2);

  // The one number a non-commercial viewer may have: the lowest price this
  // product can be sold at and still clear the margin policy. It reveals no
  // structure — you cannot work backwards to a vendor from it.
  const pct = Math.min(99, Math.max(0, num(floorPercent)));
  const floorPrice = costPerPiece > 0 ? +(costPerPiece / (1 - pct / 100)).toFixed(2) : null;

  return {
    costed: costPerPiece > 0,
    costPerPiece,
    materials: +materials.toFixed(2),
    operations: +operations.toFixed(2),
    floorPrice,
    floorPercent: pct,
  };
}

module.exports = { costingTotals, RAW_CATEGORIES };
