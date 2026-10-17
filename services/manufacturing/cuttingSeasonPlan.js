// services/manufacturing/cuttingSeasonPlan.js
//
// A CUTTING SEASON STARTED FROM PPC'S LAY (16 Oct 2026, owner: "now that you
// have the PPC concept … make it something like this and additional").
//
// PPC plans cutting on its department plan, the only place a cutting target
// goes live (an order page only proposes). Each hour of it with pieces is a
// lay, and a lay can hold pieces of several orders: `dayPlan[].layKey` is
// "cutting:<slot>" on every order's share of the same lay.
//
// Since 14 Oct 2026 a season is ONE LAY of the Daily Fabric Cutting Logbook,
// typed (cuttingLogBook.js). So a season started from PPC's lay:
//   · takes its report details from the lay — buyer, the order's MO number,
//     style, colour, date (`headerFromPlan`);
//   · is handed a SUGGESTED lay row — lay no, table, the marker and plies when
//     PPC wrote a cut plan for that hour, else a size ratio worked from the
//     pieces when one exists, and the BOM consumption from the work order's
//     fabric (`suggestLay`) — which the cutting master corrects and saves;
//   · and is compared with what PPC asked, size by size (`planCheck`).
// Nothing here refuses a lay. The floor knows things the plan does not; the
// comparison only says where the two differ.
//
// Pure: no database, no clock.
"use strict";

const SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL", "3XL"]);
const FOOT_M = 0.3048;
const str = (v) => (v == null ? "" : String(v).trim());

/** "10:30" (an hour's END, as PPC stores it) → "09:30". */
function startOf(end) {
  const m = /^(\d{2}):(\d{2})$/.exec(str(end));
  if (!m) return "";
  const t = Number(m[1]) * 60 + Number(m[2]) - 60;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** A work order's size as a log-book column (XS … 3XL), or null when it is not one (30, 40, Free). */
function sizeColumn(size) {
  const s = str(size).toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  const alias = { XXXL: "3XL", "2XL": "XXL", XXS: null, SMALL: "S", MEDIUM: "M", LARGE: "L" };
  const k = Object.prototype.hasOwnProperty.call(alias, s) ? alias[s] : s;
  return SIZES.includes(k) ? k : null;
}

/** Size and colour from a work order's variant attributes. */
function variantParts(attributes = []) {
  const get = (re) => str((attributes || []).find((a) => re.test(str(a?.name)))?.value);
  return { size: get(/size/i), colour: get(/colou?r|shade/i) };
}

/**
 * Every lay in live cutting targets between two IST days (inclusive), keyed
 * by layKey. A day-only entry (no hour) is its own lay per order. A target's
 * cut plan lay written for the same day and hour rides along (`cutPlan`).
 */
function laysFromTargets(targets, { from, to } = {}) {
  const lays = new Map();
  for (const t of targets || []) {
    if (t.status !== "active" || t.department !== "cutting") continue;
    const moId = str(t.manufacturingOrderId);
    const markers = new Map((t.cutPlan?.markers || []).map((m) => [m.key, m]));
    for (const e of t.dayPlan || []) {
      if (!(Number(e.pieces) > 0) || !e.date) continue;
      if (from && e.date < from) continue;
      if (to && e.date > to) continue;
      const key = str(e.layKey) || `cutting:${e.date}${e.time ? `T${startOf(e.time)}` : ""}:${moId}`;
      if (!lays.has(key)) lays.set(key, { layKey: key, date: e.date, time: str(e.time), start: startOf(e.time), label: str(e.label), pieces: 0, lines: new Map(), cutPlan: null });
      const lay = lays.get(key);
      if (!lay.label && e.label) lay.label = str(e.label);
      lay.pieces += Number(e.pieces);
      const wo = str(e.workOrderId);
      const lk = `${moId}|${wo}`;
      if (!lay.lines.has(lk)) lay.lines.set(lk, { workOrderId: wo || null, moId, moNumber: str(t.moNumber), customerName: str(t.customerName), targetId: str(t._id), targetFrom: str(t.from), targetTo: str(t.to), pieces: 0 });
      lay.lines.get(lk).pieces += Number(e.pieces);
      if (!lay.cutPlan) {
        const cp = (t.cutPlan?.lays || []).find((l) => l.date === e.date && str(l.time) && str(l.time) === str(e.time));
        const mk = cp ? markers.get(cp.markerKey) : null;
        if (cp && mk) lay.cutPlan = { no: cp.no, table: str(cp.table), plies: Number(cp.plies) || null, colour: str(cp.colour), ratio: mk.ratio || [], lengthM: mk.lengthM ?? null, widthCm: mk.widthCm ?? null, efficiencyPct: mk.efficiencyPct ?? null };
      }
    }
  }
  return [...lays.values()]
    .map((l) => ({ ...l, lines: [...l.lines.values()], orders: new Set([...l.lines.values()].map((x) => x.moId)).size }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || "99").localeCompare(b.start || "99") || a.label.localeCompare(b.label));
}

/** What PPC asked of the season, summed across its lays: lines, sizes, fabrics. */
function planOf(lays, { facts = new Map(), takenAt = new Date(), takenBy = null } = {}) {
  const lines = new Map();
  for (const l of lays) for (const x of l.lines) {
    const k = `${x.moId}|${x.workOrderId}`;
    if (!lines.has(k)) lines.set(k, { ...x, pieces: 0 });
    lines.get(k).pieces += x.pieces;
  }
  const fabrics = new Map();
  for (const x of lines.values()) {
    const f = facts.get(str(x.workOrderId));
    if (!f) continue;
    Object.assign(x, { workOrderNumber: f.workOrderNumber || "", productName: f.productName || "", styleNo: f.styleNo || "", size: f.size || "", colour: f.colour || "", photo: f.photo || null, bomCons: f.bomCons ?? null });
    if (f.fabric) {
      x.fabricKey = f.fabric.key; x.fabricName = f.fabric.name; x.fabricShade = f.fabric.variant || "";
      if (!fabrics.has(f.fabric.key)) fabrics.set(f.fabric.key, { key: f.fabric.key, rawItemId: f.fabric.quality, variant: f.fabric.variant || "", name: f.fabric.name, pieces: 0 });
      fabrics.get(f.fabric.key).pieces += x.pieces;
    }
  }
  const all = [...lines.values()];
  return {
    lays: lays.map((l) => ({ layKey: l.layKey, date: l.date, time: l.time, start: l.start, label: l.label, pieces: l.pieces })),
    lines: all,
    fabrics: [...fabrics.values()],
    pieces: all.reduce((a, x) => a + x.pieces, 0),
    cutPlan: lays.length === 1 ? lays[0].cutPlan || null : null,
    takenAt, takenBy,
  };
}

const uniq = (xs) => [...new Set(xs.map(str).filter(Boolean))];

/** The report details a lay gives its season: buyer, the order's MO number, style, colour, date. */
function headerFromPlan(plan) {
  const lines = plan?.lines || [];
  const shade = uniq((plan?.fabrics || []).map((f) => f.variant));
  const colours = uniq(lines.map((x) => x.colour));
  return {
    buyerName: uniq(lines.map((x) => x.customerName)).join(", "),
    poNo: uniq(lines.map((x) => x.moNumber)).join(", "),
    styleNo: uniq(lines.map((x) => x.styleNo || x.productName)).join(", "),
    colour: (colours.length ? colours : shade).join(", "),
    date: plan?.lays?.[0]?.date || "",
  };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Pieces PPC asked, per size: the log book's columns, plus any size that is not one. */
function plannedBySize(plan) {
  const columns = Object.fromEntries(SIZES.map((s) => [s, 0]));
  const other = new Map();
  for (const x of plan?.lines || []) {
    const col = sizeColumn(x.size);
    if (col) columns[col] += x.pieces;
    else other.set(x.size || "No size", (other.get(x.size || "No size") || 0) + x.pieces);
  }
  return { columns, other: [...other.entries()].map(([size, pieces]) => ({ size, pieces })) };
}

/**
 * A lay row to start from — the log book's own cell values, strings as typed.
 * From PPC's cut plan when it wrote one for this hour (marker, ratio, plies,
 * table); otherwise a size ratio and plies worked from the pieces when they
 * divide into a marker of at most 12 garments; the BOM consumption from the
 * work orders' fabric when it is in metres and the same for all of them.
 */
function suggestLay(plan, { cuttingMaster = "" } = {}) {
  if (!plan?.lays?.length) return null;
  const v = { tableNo: "", cuttingMaster: str(cuttingMaster), styleNo: "", colour: "", layNo: "", fabricLot: "", markerLength: "", markerWidth: "", markerEff: "", ratio: Object.fromEntries(SIZES.map((s) => [s, ""])), plies: "", fabricIssued: "", fabricReturned: "", bomCons: "", remarks: "" };
  const h = headerFromPlan(plan);
  v.styleNo = h.styleNo; v.colour = h.colour;
  const nums = plan.lays.flatMap((l) => (str(l.label).match(/\d+/g) || []));
  if (nums.length) v.layNo = nums.length === 1 ? nums[0] : `${nums[0]}–${nums[nums.length - 1]}`;
  const f = plan.fabrics || [];
  if (f.length === 1) v.fabricLot = [f[0].name, f[0].variant].filter(Boolean).join(" · ");
  const boms = uniq((plan.lines || []).map((x) => (x.bomCons == null ? "" : String(x.bomCons))));
  if (boms.length === 1) v.bomCons = boms[0];
  const from = [];
  const cp = plan.cutPlan;
  if (cp && (cp.ratio || []).some((r) => sizeColumn(r.size))) {
    for (const r of cp.ratio || []) { const col = sizeColumn(r.size); if (col && Number(r.count) > 0) v.ratio[col] = String(r.count); }
    if (cp.plies) v.plies = String(cp.plies);
    if (cp.lengthM) v.markerLength = String(Math.round((cp.lengthM / FOOT_M) * 100) / 100);
    if (cp.widthCm) v.markerWidth = String(Math.round((cp.widthCm / 100 / FOOT_M) * 100) / 100);
    if (cp.efficiencyPct) v.markerEff = String(cp.efficiencyPct);
    if (cp.table) v.tableNo = cp.table;
    if (cp.no && !v.layNo) v.layNo = String(cp.no);
    from.push("PPC's cut plan");
  } else {
    const { columns, other } = plannedBySize(plan);
    const sizes = SIZES.filter((s) => columns[s] > 0);
    if (sizes.length && !other.length) {
      const g = sizes.reduce((a, s) => gcd(a, columns[s]), 0);
      const perPly = sizes.reduce((a, s) => a + columns[s] / g, 0);
      if (g > 1 && perPly <= 12) {
        for (const s of sizes) v.ratio[s] = String(columns[s] / g);
        v.plies = String(g);
        from.push("the pieces PPC planned");
      }
    }
  }
  return { values: v, from };
}

/** What the lay cuts against what PPC asked, size by size and in all. */
function planCheck(plan, lays = []) {
  if (!plan?.lays?.length) return null;
  const { columns, other } = plannedBySize(plan);
  const cut = Object.fromEntries(SIZES.map((s) => [s, 0]));
  for (const l of lays) for (const s of SIZES) cut[s] += (Number(l.ratio?.[s]) || 0) * (Number(l.plies) || 0);
  const rows = SIZES.filter((s) => columns[s] || cut[s]).map((s) => ({ size: s, planned: columns[s], cut: cut[s], diff: cut[s] - columns[s] }));
  const planned = plan.pieces;
  const cutTotal = SIZES.reduce((a, s) => a + cut[s], 0);
  const notes = [];
  if (other.length) notes.push(`PPC's sizes ${other.map((o) => o.size).join(", ")} are not columns of the log book, so they are compared in the total only.`);
  const styles = uniq((plan.lines || []).map((x) => x.styleNo || x.productName).map((s) => s.toLowerCase()));
  const typed = uniq(lays.map((l) => str(l.styleNo).toLowerCase()));
  if (typed.length && styles.length && typed.some((t) => !styles.includes(t))) notes.push(`The lay's style (${uniq(lays.map((l) => l.styleNo)).join(", ")}) is not one PPC planned for this lay.`);
  return {
    rows, other, planned, cut: cutTotal, diff: cutTotal - planned,
    state: !lays.length ? "not_cut" : cutTotal === planned ? "matches" : cutTotal < planned ? "short" : "over",
    notes,
  };
}

const PRIORITY = ["low", "medium", "high", "urgent"];
/**
 * What a lay is due by, from its lines (16 Oct 2026, owner: "important
 * details from PPC — the target, the deadline"): the earliest PPC target end
 * for cutting, the earliest customer delivery, and the highest priority.
 * Dates are IST days ("YYYY-MM-DD"); an absent one stays absent.
 */
function dueOf(lines = []) {
  const earliest = (k) => lines.map((x) => str(x[k]).slice(0, 10)).filter(Boolean).sort()[0] || "";
  const pr = lines.map((x) => PRIORITY.indexOf(str(x.priority))).filter((i) => i >= 0);
  return { targetTo: earliest("targetTo"), deliveryDeadline: earliest("deliveryDeadline"), priority: pr.length ? PRIORITY[Math.max(...pr)] : "" };
}

module.exports = { dueOf, SIZES, startOf, sizeColumn, variantParts, laysFromTargets, planOf, headerFromPlan, plannedBySize, suggestLay, planCheck };
