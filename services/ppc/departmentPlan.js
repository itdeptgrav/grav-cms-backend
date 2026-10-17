// services/ppc/departmentPlan.js — ONE DEPARTMENT'S PLAN, ACROSS ALL ORDERS
//
// (16 Oct 2026, owner: "a lay could be for 2–3 orders … it should come from
// PPC … let's give PPC a department-wise page".) PPC plans per ORDER — one
// PpcOrderTarget per order and department — and keeps doing so. The
// department plan is the same grid as the order plan (work orders × days
// that open into hours) with the work orders of EVERY order as rows, so one
// hour column can carry pieces of three orders: in Cutting that column is
// ONE lay. Saved, it becomes each order's ordinary target — its share of the
// department plan — and the slot is what ties the orders' shares together:
// the same department, day and hour IS the same lay (`layKey`).
//
// Pure. The service (departmentPlan.service.js) reads and writes.
"use strict";

const shift = require("../manufacturing/shiftHours");

/* The nine shift hours, as the plan grid names them: an hour is keyed by its
   START ("10:30") and an entry is due at its END ("11:30"). */
const SLOTS = (() => {
  const out = [];
  for (let m = shift.SHIFT_START_MIN; m < shift.SHIFT_END_MIN; m += 60) out.push({ from: shift.hhmm(m), to: shift.hhmm(Math.min(m + 60, shift.SHIFT_END_MIN)) });
  return out;
})();
const START_OF_END = new Map(SLOTS.map((s) => [s.to, s.from]));
const END_OF_START = new Map(SLOTS.map((s) => [s.from, s.to]));

/* How each department's columns are named on the target (the CMS's
   lib/production/stageProfiles.mjs is the same list, with its words). */
const BATCH_NOUN = Object.freeze({ cutting: ["Lay", "Lays"], washing: ["Load", "Loads"], embroidery: ["Run", "Runs"] });
const DAY_ONLY = new Set(["dispatch"]);

const int = (v) => Math.max(0, Math.round(Number(v) || 0));
const slotOf = (date, time) => (time && START_OF_END.has(time) ? `${date}T${START_OF_END.get(time)}` : date);

/**
 * The department's current plan, as grid cells, from the orders' active
 * targets: every dayPlan entry that names a work order. Targets planned some
 * other way (a daily pace, a finish date) are listed apart — the plan does
 * not pretend to know their hours.
 * → { cells: {[woId]: {[slot]: pieces}}, planned: [targetId], other: [{targetId, moId, kind}] }
 */
function cellsFromTargets(targets, department) {
  const cells = {}, planned = [], other = [];
  for (const t of targets || []) {
    if (t.department !== department || t.status !== "active") continue;
    const plan = (t.dayPlan || []).filter((e) => e && e.workOrderId && int(e.pieces) > 0);
    if (!plan.length) { other.push({ targetId: String(t._id), moId: String(t.manufacturingOrderId), kind: t.kind, planSource: t.planSource || "" }); continue; }
    planned.push(String(t._id));
    for (const e of plan) {
      const k = slotOf(e.date, e.time);
      cells[e.workOrderId] = cells[e.workOrderId] || {};
      cells[e.workOrderId][k] = (cells[e.workOrderId][k] || 0) + int(e.pieces);
    }
  }
  return { cells, planned, other };
}

/**
 * The saved grid → one plan per order. Every entry is labelled the way the
 * department reads it, numbered ACROSS orders: Cutting's 10:30 hour is "Lay 1"
 * on every order that has pieces in it, and two machines' worth is "Lays
 * 1–2". `layKey` (department + slot) is the cross-order identity.
 *   entries: [{ workOrderId, slot, pieces }]   (slot as cellsFromTargets)
 *   woById:  Map id → { moId }
 * → { orders: Map moId → { dayPlan, allocations }, problems: [string] }
 */
function plansFromCells(entries, woById, { department, perBatch = 0 } = {}) {
  const problems = [];
  const clean = [];
  for (const e of entries || []) {
    const pieces = int(e.pieces);
    if (!pieces) continue;
    const wo = woById.get(String(e.workOrderId));
    if (!wo) { problems.push(`A work order on the plan (${e.workOrderId}) is not open at this department.`); continue; }
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(String(e.slot || ""));
    if (!m) { problems.push(`${wo.number || e.workOrderId}: "${e.slot}" is not a day or an hour of the shift.`); continue; }
    if (m[2] && !END_OF_START.has(m[2])) { problems.push(`${wo.number || e.workOrderId}: ${m[2]} is not the start of a shift hour.`); continue; }
    if (m[2] && DAY_ONLY.has(department)) { problems.push(`${wo.number || e.workOrderId}: dispatch is planned by the day, not the hour.`); continue; }
    clean.push({ wo, woId: String(e.workOrderId), date: m[1], hour: m[2] || "", pieces });
  }

  /* number the batches across every order, in time order */
  const noun = BATCH_NOUN[department];
  const hourTotals = new Map();
  for (const e of clean) if (e.hour) hourTotals.set(`${e.date}T${e.hour}`, (hourTotals.get(`${e.date}T${e.hour}`) || 0) + e.pieces);
  const batchOf = new Map();
  let next = 1;
  for (const k of [...hourTotals.keys()].sort()) {
    const count = noun && perBatch > 0 ? Math.max(1, Math.ceil(hourTotals.get(k) / perBatch)) : 1;
    batchOf.set(k, { first: next, last: next + count - 1, count });
    next += count;
  }
  const dayNo = new Map([...new Set(clean.map((e) => e.date))].sort().map((d, i) => [d, i + 1]));

  const orders = new Map();
  for (const e of clean) {
    const k = e.hour ? `${e.date}T${e.hour}` : e.date;
    const b = batchOf.get(k);
    const label = e.hour
      ? (noun ? (b.count > 1 ? `${noun[1]} ${b.first}–${b.last}` : `${noun[0]} ${b.first}`) : `${e.hour}–${END_OF_START.get(e.hour)}`)
      : (department === "dispatch" ? `Shipment ${dayNo.get(e.date)}` : "");
    const moId = String(e.wo.moId);
    if (!orders.has(moId)) orders.set(moId, { dayPlan: [], byWo: new Map() });
    const o = orders.get(moId);
    o.dayPlan.push({ date: e.date, time: e.hour ? END_OF_START.get(e.hour) : "", workOrderId: e.woId, pieces: e.pieces, label, layKey: `${department}:${k}` });
    o.byWo.set(e.woId, (o.byWo.get(e.woId) || 0) + e.pieces);
  }
  for (const o of orders.values()) {
    o.dayPlan.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    o.allocations = [...o.byWo.entries()].map(([workOrderId, quantity]) => ({ workOrderId, quantity }));
    delete o.byWo;
  }

  /* the department's balance on each work order is the ceiling */
  const perWo = new Map();
  for (const e of clean) perWo.set(e.woId, (perWo.get(e.woId) || 0) + e.pieces);
  for (const [id, q] of perWo) {
    const wo = woById.get(id);
    if (wo && Number.isFinite(wo.left) && q > wo.left) problems.push(`${wo.number || id}: ${q} planned, but only ${wo.left} remain at this department.`);
  }
  return { orders, problems };
}

/**
 * A work order's FABRIC: of its raw materials, the one the Item Master files
 * under a fabric category ("Fabric", "Suiting fabric" …) — metres alone are
 * not enough: fusing, waistband and thread are in metres too. Several
 * fabrics → the one it needs most of. The key is the raw item and its
 * variant, so "SuitingFabric 63/37PC · Black" and "· Navy" are two fabrics.
 *   rawMaterials: the work order's own list
 *   categoryOf:   Map rawItemId → category
 * → { key, name, variant } | null
 */
function fabricOf(rawMaterials, categoryOf) {
  const fabrics = (rawMaterials || []).filter((r) => r && r.rawItemId && /fabric/i.test(String(categoryOf.get(String(r.rawItemId)) || "")));
  if (!fabrics.length) return null;
  const f = fabrics.reduce((a, b) => ((Number(b.quantityRequired) || 0) > (Number(a.quantityRequired) || 0) ? b : a));
  const combo = (f.rawItemVariantCombination || []).filter(Boolean);
  const variant = f.rawItemVariantId ? String(f.rawItemVariantId) : combo.join("/");
  /* the shade is the part of the combination a planner reads: the last
     word-bearing value, without a supplier's code in brackets */
  const shade = combo.length ? String(combo[combo.length - 1]).replace(/\s*\(.*\)\s*$/, "") : "";
  return { key: `${f.rawItemId}:${variant}`, quality: String(f.rawItemId), name: String(f.name || "").trim(), variant: shade };
}

/**
 * What a cutting lay may hold (owner, 16 Oct 2026: "two different products
 * with different fabrics in a single lay — isn't that impossible?"). A lay is
 * spread ply on ply and cut by ONE marker, so:
 *   - two fabric QUALITIES (suiting and shirting) — never one lay;
 *   - one quality in two SHADES — a multi-shade lay, but only of ONE product
 *     (every ply is cut by the same marker);
 *   - one fabric and shade, several products — fine: one marker can carry
 *     both.
 * An hour holding k lays (several tables) may hold k fabrics. Work orders
 * whose bill names no fabric are not judged — nothing is known about them.
 *   parts: [{ fabric: {key, quality, name, variant} | null, product }]
 * → { level: "error" | "warning" | null, text }
 */
function layMix(parts, lays = 1) {
  const known = parts.filter((p) => p.fabric && p.fabric.key);
  const fabrics = [...new Set(known.map((p) => p.fabric.key))];
  if (fabrics.length <= Math.max(1, lays)) return { level: null, text: "" };
  const qualities = [...new Set(known.map((p) => p.fabric.quality))];
  const names = fabrics.map((k) => { const f = known.find((p) => p.fabric.key === k).fabric; return [f.name, f.variant].filter(Boolean).join(" · "); });
  if (qualities.length > Math.max(1, lays)) return { level: "error", text: `different fabrics in one lay (${names.join(" and ")})` };
  const products = [...new Set(known.map((p) => p.product))];
  if (products.length > 1) return { level: "error", text: `two shades of two products in one lay (${names.join(" and ")}) — a multi-shade lay is cut by one marker, so one product` };
  return { level: "warning", text: `a multi-shade lay (${names.join(" and ")}) — spread with the shades separated` };
}

module.exports = { SLOTS, BATCH_NOUN, cellsFromTargets, plansFromCells, slotOf, fabricOf, layMix };
