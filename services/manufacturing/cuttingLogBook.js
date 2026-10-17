// services/manufacturing/cuttingLogBook.js
//
// THE DAILY FABRIC CUTTING LOGBOOK (14 Oct 2026, owner). A cutting season is
// no longer scanned: the cutting master fills in the floor's own register
// ("Daily Cutting Report Grav.xlsx") — one row per lay — and the season's
// report downloads as that same workbook. This module is the register's
// arithmetic, column for column, so the screen and the downloaded file read
// one set of figures (the routes send them; the workbook writes them).
//
// Typed per lay (the log book's input columns):
//   Date, Table No, Cutting Master, Style No, Colour, Lay No, Fabric Lot /
//   Shade, Marker Length (m), Marker Width (in), Marker Eff %, the size ratio
//   (garments per size in the marker, XS … 3XL), No. of Plies, Fabric Issued
//   (m), Fabric Returned (m), BOM Cons (m/pc), Remarks.
// Worked out, with the workbook's own formulas:
//   Garments / Ply   = SUM(size ratio)
//   Pcs Cut          = Garments / Ply × Plies
//   Fabric Consumed  = Issued − Returned
//   Marker Req       = Marker Length × Plies
//   Wastage          = Consumed − Marker Req
//   Wastage %        = Wastage ÷ Consumed
//   Actual Cons      = Consumed ÷ Pcs Cut
//   Consm Var %      = (Actual Cons − BOM Cons) ÷ BOM Cons
//   Status           = "OK" within ±STATUS_TOLERANCE of BOM, else "Over BOM" / "Under BOM"
//                      (the workbook colours "OK" green and anything else orange;
//                       "Flagged Lays" on the daily report counts the others)
"use strict";

const SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL", "3XL"]);
/** Consumption within ±3% of the BOM is "OK". */
const STATUS_TOLERANCE = 0.03;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n, dp = 4) => (n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const str = (v, max = 120) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim()).slice(0, max);

/* MARKER LENGTH AND WIDTH ARE TYPED IN FEET (15 Oct 2026, owner). A lay
   saved since carries `markerUnit: "ft"`; one saved before has none and its
   figures are metres (length) and inches (width). The arithmetic always works
   in metres, so the two kinds of lay sit in one report. */
const FOOT_M = 0.3048;
/** The marker length in metres, whatever unit the lay was typed in. */
function markerLengthM(l = {}) {
  const n = num(l.markerLength);
  if (n === null) return null;
  return l.markerUnit === "ft" ? n * FOOT_M : n;
}
/** The lay's marker as shown and reported: in feet, converted for an older lay. */
function inFeet(l = {}) {
  if (l.markerUnit === "ft") return { markerLength: l.markerLength ?? null, markerWidth: l.markerWidth ?? null, markerUnit: "ft" };
  const len = num(l.markerLength);
  const wid = num(l.markerWidth);
  return {
    markerLength: len === null ? null : Math.round((len / FOOT_M) * 10000) / 10000,
    markerWidth: wid === null ? null : Math.round((wid / 12) * 10000) / 10000,
    markerUnit: "ft",
  };
}

/* SIZES THAT ARE NOT XS…3XL (17 Oct 2026, owner — a shirt in size 30 opened
   on an empty sheet): any other size a lay is typed with is kept in
   `ratioExtra` ({ "30": 3 }) and counts in garments a ply and pieces cut like
   a column size. A size is a short label; "." and "$" cannot be keys. */
const extraKey = (k) => String(k || "").trim().replace(/[.$]/g, "-").slice(0, 12);
/** A lay's sizes outside the log-book columns, { size: garments a ply }. */
function extrasOf(l = {}) {
  const out = {};
  for (const [k, v] of Object.entries(l.ratioExtra || {})) { const n = Number(v) || 0; if (n > 0) out[k] = n; }
  return out;
}

/** A lay as typed → the stored shape, or { error } naming the first problem. */
function normaliseLay(input = {}) {
  const ratio = {};
  for (const s of SIZES) {
    const n = num(input.ratio?.[s]);
    if (n !== null && (n < 0 || !Number.isInteger(n))) return { error: `Size ${s}: the ratio is a whole number of garments, 0 or more.` };
    ratio[s] = n || 0;
  }
  const ratioExtra = {};
  for (const [k, v] of [...Object.entries(input.ratio || {}), ...Object.entries(input.ratioExtra || {})]) {
    if (SIZES.includes(k)) continue;
    const key = extraKey(k); const n = num(v);
    if (!key || n === null) continue;
    if (n < 0 || !Number.isInteger(n)) return { error: `Size ${key}: the ratio is a whole number of garments, 0 or more.` };
    if (n > 0) ratioExtra[key] = n;
  }
  const date = input.date ? new Date(input.date) : null;
  if (!date || Number.isNaN(date.getTime())) return { error: "Give the lay's date." };
  const styleNo = str(input.styleNo);
  if (!styleNo) return { error: "Give the style number." };
  const plies = num(input.plies);
  if (plies === null || plies <= 0 || !Number.isInteger(plies)) return { error: "No. of plies must be a whole number above 0." };
  if (!SIZES.some((s) => ratio[s] > 0) && !Object.keys(ratioExtra).length) return { error: "Give the size ratio — how many garments of each size the marker holds." };
  const markerLength = num(input.markerLength);
  const markerUnit = input.markerUnit === "ft" ? "ft" : "m";
  if (markerLength === null || markerLength <= 0) return { error: `Marker length (${markerUnit === "ft" ? "ft" : "m"}) must be above 0.` };
  const markerWidth = num(input.markerWidth);
  if (markerWidth !== null && markerWidth <= 0) return { error: `Marker width (${markerUnit === "ft" ? "ft" : "in"}) must be above 0.` };
  /* Typed as a percentage on the screen (84) and stored as the workbook stores it (0.84). */
  let markerEff = num(input.markerEff);
  if (markerEff !== null) {
    if (markerEff > 1) markerEff = markerEff / 100;
    if (markerEff < 0 || markerEff > 1) return { error: "Marker efficiency is a percentage between 0 and 100." };
  }
  const fabricIssued = num(input.fabricIssued);
  const fabricReturned = num(input.fabricReturned);
  if (fabricIssued !== null && fabricIssued < 0) return { error: "Fabric issued cannot be negative." };
  if (fabricReturned !== null && fabricReturned < 0) return { error: "Fabric returned cannot be negative." };
  if (fabricReturned !== null && fabricIssued === null) return { error: "Give the fabric issued before the fabric returned." };
  if (fabricIssued !== null && fabricReturned !== null && fabricReturned > fabricIssued) return { error: "More fabric returned than was issued." };
  const bomCons = num(input.bomCons);
  if (bomCons !== null && bomCons <= 0) return { error: "BOM consumption (m/pc) must be above 0." };
  return {
    lay: {
      date,
      tableNo: str(input.tableNo, 30),
      cuttingMaster: str(input.cuttingMaster, 80),
      styleNo,
      colour: str(input.colour, 60),
      layNo: str(input.layNo, 30),
      fabricLot: str(input.fabricLot, 80),
      markerLength: round(markerLength),
      markerWidth: markerWidth === null ? null : round(markerWidth),
      markerUnit,
      markerEff: markerEff === null ? null : round(markerEff),
      ratio,
      ratioExtra,
      plies,
      fabricIssued: fabricIssued === null ? null : round(fabricIssued),
      fabricReturned: fabricReturned === null ? null : round(fabricReturned),
      bomCons: bomCons === null ? null : round(bomCons),
      remarks: str(input.remarks, 500),
    },
  };
}

/** The log book's worked-out columns for one lay. Blank where the workbook leaves them blank. */
function computeLay(l = {}) {
  const ratio = l.ratio || {};
  const garmentsPerPly = SIZES.reduce((n, s) => n + (Number(ratio[s]) || 0), 0) + Object.values(extrasOf(l)).reduce((a, b) => a + b, 0);
  const plies = num(l.plies) || 0;
  const pcsCut = garmentsPerPly * plies;
  const issued = num(l.fabricIssued);
  const returned = num(l.fabricReturned);
  const consumed = issued === null ? null : issued - (returned || 0);
  const mlM = markerLengthM(l);
  const markerReq = mlM === null || !plies ? null : mlM * plies;
  const wastage = consumed === null || markerReq === null ? null : consumed - markerReq;
  const wastagePct = wastage === null || !consumed ? null : wastage / consumed;
  const actualCons = consumed === null || !pcsCut ? null : consumed / pcsCut;
  const bom = num(l.bomCons);
  const consVarPct = actualCons === null || !bom ? null : (actualCons - bom) / bom;
  const status = consVarPct === null ? "" : Math.abs(consVarPct) <= STATUS_TOLERANCE ? "OK" : consVarPct > 0 ? "Over BOM" : "Under BOM";
  return {
    garmentsPerPly,
    pcsCut,
    fabricConsumed: round(consumed),
    markerReq: round(markerReq),
    wastage: round(wastage),
    wastagePct: round(wastagePct, 6),
    actualCons: round(actualCons, 6),
    consVarPct: round(consVarPct, 6),
    status,
  };
}

/** The daily report's CUTTING SUMMARY and SIZE-WISE PCS CUT, over these lays. */
function summarize(lays = []) {
  const rows = lays.map((l) => ({ ...l, ...computeLay(l) }));
  const sum = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const anyIssued = rows.some((r) => r.fabricIssued !== null && r.fabricIssued !== undefined);
  const issued = anyIssued ? sum("fabricIssued") : null;
  const returned = anyIssued ? sum("fabricReturned") : null;
  const consumed = anyIssued ? sum("fabricConsumed") : null;
  /* Marker requirement and wastage over the lays whose fabric was recorded,
     so the two sides of "consumed − required" cover the same lays. */
  const withFabric = rows.filter((r) => r.fabricConsumed !== null && r.markerReq !== null);
  const markerReq = rows.length ? sum("markerReq") : null;
  const wastage = withFabric.length ? withFabric.reduce((n, r) => n + r.wastage, 0) : null;
  const consumedWithFabric = withFabric.reduce((n, r) => n + r.fabricConsumed, 0);
  const pcsCut = sum("pcsCut");
  const pcsWithFabric = rows.filter((r) => r.fabricConsumed !== null).reduce((n, r) => n + r.pcsCut, 0);
  const sizeWise = {};
  for (const s of SIZES) sizeWise[s] = rows.reduce((n, r) => n + (Number(r.ratio?.[s]) || 0) * (Number(r.plies) || 0), 0);
  /* the other sizes, beside the columns */
  const sizeWiseExtra = {};
  for (const r of rows) for (const [k, v] of Object.entries(extrasOf(r))) sizeWiseExtra[k] = (sizeWiseExtra[k] || 0) + v * (Number(r.plies) || 0);
  return {
    lays: rows.length,
    totalPlies: sum("plies"),
    pcsCut,
    fabricIssued: round(issued),
    fabricReturned: round(returned),
    fabricConsumed: round(consumed),
    markerReq: round(markerReq),
    wastage: round(wastage),
    wastagePct: wastage === null || !consumedWithFabric ? null : round(wastage / consumedWithFabric, 6),
    avgCons: consumed === null || !pcsWithFabric ? null : round(consumed / pcsWithFabric, 6),
    flaggedLays: rows.filter((r) => r.status && r.status !== "OK").length,
    sizeWise,
    sizeWiseExtra,
    sizeTotal: SIZES.reduce((n, s) => n + sizeWise[s], 0) + Object.values(sizeWiseExtra).reduce((a, b) => a + b, 0),
  };
}

/**
 * The calendar day a season stands for, as the log book stores a date: that
 * day at UTC midnight. A season has ONE lay and its date is the season's —
 * the report header's date when one is set, else the day it was created, read
 * in India so an evening season stays on its own day (14 Oct 2026, owner).
 */
function seasonDay(season) {
  const src = season?.header?.date || season?.createdAt || null;
  const t = src ? new Date(src) : null;
  if (!t || Number.isNaN(t.getTime())) return null;
  const isMidnightUtc = t.getUTCHours() === 0 && t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0;
  const ist = isMidnightUtc ? t : new Date(t.getTime() + 330 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A season's name, made from what was typed into it (14 Oct 2026, owner: "why
 * is it asking the season name … keep the name from that form", then "the
 * name is too big — just the MO number"): the MO number from the report
 * details. Before one is typed it is the day, "14 Oct · New season". The list
 * already shows the day, style and pieces beside the name.
 */
function seasonName(season) {
  const mo = String(season?.header?.poNo || "").trim();
  if (mo) return mo.slice(0, 120);
  const d = seasonDay(season);
  return d ? `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} · New season` : "New season";
}

/** "2026-10-01" → that day at UTC midnight; anything else → null. */
function dayFrom(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The report header's date, as typed. */
function normaliseHeader(input = {}) {
  const date = input.date ? new Date(input.date) : null;
  return {
    buyerName: str(input.buyerName, 120),
    poNo: str(input.poNo, 60),
    styleNo: str(input.styleNo, 60),
    colour: str(input.colour, 60),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
  };
}

module.exports = { extrasOf, SIZES, STATUS_TOLERANCE, FOOT_M, normaliseLay, normaliseHeader, computeLay, summarize, seasonDay, seasonName, dayFrom, inFeet, markerLengthM };
