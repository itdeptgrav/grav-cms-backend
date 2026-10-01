// services/manufacturing/stageReport.js
//
// ONE REPORT SHAPE FOR EVERY STAGE THAT RECORDS PIECES.
//
// Packaging, Printing, Washing, Trimming and Ironing all produce the same
// fact — "these pieces of this work order were done by this person at this
// moment" — so their reports are built by one aggregation from one event
// shape. The workbook the CMS downloads is laid out from what this returns and
// computes nothing of its own: a spreadsheet whose total disagrees with the
// screen it came from is worse than no spreadsheet.
//
// Event shape (built by each route from its own records):
//   { at: Date, personKey, personName, personEmployeeId, qty, units: [Number],
//     woId, woNumber, product, reference, variant (text),
//     moId, moNumber, customerName, poNumber, requestType,
//     cartonNumber?, source?, barcode? }
//
// Every hour-wise figure uses the factory's shift buckets (shiftHours.js).
"use strict";

const shift = require("./shiftHours");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 186;

/** [1,2,3,5,7,8,9] → "1–3, 5, 7–9". */
function compactRanges(nums) {
  const s = [...new Set((nums || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!s.length) return "";
  const parts = [];
  let start = s[0], prev = s[0];
  for (let i = 1; i <= s.length; i++) {
    const n = s[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n; prev = n;
  }
  return parts.join(", ");
}

/**
 * The period a report covers. `from`/`to` are IST calendar days; both missing
 * means today; `all` means no bound (the caller then reads everything).
 * Refused when malformed or longer than MAX_SPAN_DAYS.
 */
function reportWindow(query = {}) {
  if (String(query.all || "") === "1") return { all: true, start: null, end: null, from: null, to: null };
  const today = shift.istDayWindow().label;
  let from = DAY_RE.test(String(query.from || "")) ? String(query.from) : null;
  let to = DAY_RE.test(String(query.to || "")) ? String(query.to) : null;
  if (!from && !to) from = to = today;
  if (!from) from = to;
  if (!to) to = from;
  if (from > to) [from, to] = [to, from];
  const start = shift.istDayWindow(from).start;
  const end = shift.istDayWindow(to).end;
  const span = Math.round((end - start) / 86400000);
  if (span > MAX_SPAN_DAYS) {
    const err = new Error(`A report covers at most ${MAX_SPAN_DAYS} days; this asks for ${span}.`);
    err.status = 400;
    throw err;
  }
  return { all: false, start, end, from, to };
}

/** Every IST day from → to, as keys. Capped so a long "all dates" stays sane. */
function dayKeys(from, to, cap = 400) {
  const out = [];
  for (let d = from; d <= to && out.length < cap; d = shift.shiftDayKey(d, 1)) out.push(d);
  return out;
}

/**
 * @param {object}   args
 * @param {Array}    args.events       see header
 * @param {object}   args.window       from reportWindow()
 * @param {Map}      args.woTotals     woId -> { quantity, doneOverall }
 * @param {string}   args.unitLabel    "pieces"
 */
function buildStageReport({ events, window, woTotals = new Map() }) {
  const evs = [...events].sort((a, b) => a.at - b.at);

  // The days the report spans. For "all dates", first → last event.
  const firstDay = window.all ? (evs.length ? shift.istDayKeyOf(evs[0].at) : shift.istDayWindow().label) : window.from;
  const lastDay = window.all ? (evs.length ? shift.istDayKeyOf(evs[evs.length - 1].at) : firstDay) : window.to;
  let days = dayKeys(firstDay, lastDay);
  const spanTooLong = days.length > 62;

  const bucketDefs = shift.shiftBuckets();
  const hours = bucketDefs.map((b) => ({ key: b.key, label: b.label, outside: b.outside, pieces: 0, byDay: {}, byPerson: {} }));
  const dayMap = new Map(days.map((d) => [d, { date: d, pieces: 0, events: 0, people: new Map(), orders: new Set(), workOrders: new Set(), cartons: new Set() }]));
  const people = new Map();
  const orders = new Map();
  const variants = new Map();

  for (const e of evs) {
    const qty = Number(e.qty) || 0;
    const dayKey = shift.istDayKeyOf(e.at);
    const b = hours[shift.bucketIndexOf(e.at)];
    b.pieces += qty;
    b.byDay[dayKey] = (b.byDay[dayKey] || 0) + qty;
    b.byPerson[e.personKey] = (b.byPerson[e.personKey] || 0) + qty;

    let d = dayMap.get(dayKey);
    if (!d) { d = { date: dayKey, pieces: 0, events: 0, people: new Map(), orders: new Set(), workOrders: new Set(), cartons: new Set() }; dayMap.set(dayKey, d); }
    d.pieces += qty; d.events += 1;
    d.people.set(e.personKey, { name: e.personName, pieces: (d.people.get(e.personKey)?.pieces || 0) + qty });
    if (e.moId) d.orders.add(e.moId);
    d.workOrders.add(e.woId);
    if (e.cartonNumber) d.cartons.add(e.cartonNumber);

    const p = people.get(e.personKey) || {
      key: e.personKey, name: e.personName || "Unknown", employeeId: e.personEmployeeId || "",
      pieces: 0, events: 0, orders: new Set(), workOrders: new Set(), cartons: new Set(), days: new Map(), firstAt: e.at, lastAt: e.at,
    };
    p.pieces += qty; p.events += 1;
    if (e.moId) p.orders.add(e.moId);
    p.workOrders.add(e.woId);
    if (e.cartonNumber) p.cartons.add(e.cartonNumber);
    p.days.set(dayKey, (p.days.get(dayKey) || 0) + qty);
    if (!p.employeeId && e.personEmployeeId) p.employeeId = e.personEmployeeId;
    if (e.at < p.firstAt) p.firstAt = e.at;
    if (e.at > p.lastAt) p.lastAt = e.at;
    people.set(e.personKey, p);

    const ok = e.moId || "(no order)";
    const o = orders.get(ok) || {
      moId: e.moId || null, moNumber: e.moNumber || "(no order)", customerName: e.customerName || "",
      poNumber: e.poNumber || "", requestType: e.requestType || "", pieces: 0, workOrders: new Map(),
    };
    o.pieces += qty;
    const w = o.workOrders.get(e.woId) || {
      woId: e.woId, woNumber: e.woNumber, product: e.product, reference: e.reference || "", variant: e.variant,
      pieces: 0, units: [], people: new Map(), cartons: new Set(), firstAt: e.at, lastAt: e.at,
    };
    w.pieces += qty;
    w.units.push(...(e.units || []));
    w.people.set(e.personKey, { name: e.personName, pieces: (w.people.get(e.personKey)?.pieces || 0) + qty });
    if (e.cartonNumber) w.cartons.add(e.cartonNumber);
    if (e.at > w.lastAt) w.lastAt = e.at;
    o.workOrders.set(e.woId, w);
    orders.set(ok, o);

    const vk = `${e.product}|${e.reference}|${e.variant}`;
    const v = variants.get(vk) || { product: e.product, reference: e.reference || "", variant: e.variant, pieces: 0, workOrders: new Set(), orders: new Set() };
    v.pieces += qty; v.workOrders.add(e.woId); if (e.moId) v.orders.add(e.moId);
    variants.set(vk, v);
  }

  // A long "all dates" span lists only the days that have work.
  let dayRows = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (spanTooLong) { dayRows = dayRows.filter((d) => d.pieces > 0); days = dayRows.map((d) => d.date); }

  const byName = (a, b) => b.pieces - a.pieces || String(a.name).localeCompare(String(b.name));
  const peopleRows = [...people.values()].map((p) => ({
    key: p.key, name: p.name, employeeId: p.employeeId, pieces: p.pieces, events: p.events,
    orders: p.orders.size, workOrders: p.workOrders.size, cartons: p.cartons.size,
    activeDays: p.days.size, avgPerActiveDay: p.days.size ? Math.round(p.pieces / p.days.size) : 0,
    firstAt: p.firstAt, lastAt: p.lastAt, byDay: Object.fromEntries(p.days),
  })).sort(byName);

  const total = evs.reduce((n, e) => n + (Number(e.qty) || 0), 0);
  const inShift = hours.filter((h) => !h.outside);
  const peak = hours.filter((h) => h.pieces > 0).reduce((m, h) => (!m || h.pieces > m.pieces ? h : m), null);
  const activeDays = dayRows.filter((d) => d.pieces > 0).length;

  return {
    period: { from: firstDay, to: lastDay, all: Boolean(window.all), days, perDayColumns: !spanTooLong && days.length <= 31 },
    shift: shift.SHIFT,
    summary: {
      pieces: total,
      events: evs.length,
      people: peopleRows.length,
      orders: orders.size,
      workOrders: new Set(evs.map((e) => e.woId)).size,
      activeDays,
      avgPerActiveDay: activeDays ? Math.round(total / activeDays) : 0,
      activeShiftHours: inShift.filter((h) => h.pieces > 0).length,
      outsideShift: hours.filter((h) => h.outside).reduce((n, h) => n + h.pieces, 0),
      peakHour: peak ? { label: peak.label, pieces: peak.pieces } : null,
      firstAt: evs[0]?.at || null,
      lastAt: evs[evs.length - 1]?.at || null,
    },
    hours,
    days: dayRows.map((d) => ({
      date: d.date, pieces: d.pieces, events: d.events, orders: d.orders.size, workOrders: d.workOrders.size,
      cartons: d.cartons.size, people: [...d.people.values()].sort(byName),
    })),
    people: peopleRows,
    orders: [...orders.values()].sort((a, b) => b.pieces - a.pieces).map((o) => ({
      moId: o.moId, moNumber: o.moNumber, customerName: o.customerName, poNumber: o.poNumber,
      requestType: o.requestType, pieces: o.pieces,
      workOrders: [...o.workOrders.values()].sort((a, b) => String(a.product).localeCompare(String(b.product)) || String(a.variant).localeCompare(String(b.variant))).map((w) => {
        const t = woTotals.get(String(w.woId)) || {};
        return {
          woId: w.woId, woNumber: w.woNumber, product: w.product, reference: w.reference, variant: w.variant,
          quantity: t.quantity ?? null, pieces: w.pieces, doneOverall: t.doneOverall ?? null,
          remaining: t.quantity != null && t.doneOverall != null ? Math.max(0, t.quantity - t.doneOverall) : null,
          units: compactRanges(w.units), people: [...w.people.values()].sort(byName),
          cartons: [...w.cartons].sort(), lastAt: w.lastAt,
        };
      }),
    })),
    variants: [...variants.values()].sort((a, b) => b.pieces - a.pieces).map((v) => ({
      product: v.product, reference: v.reference, variant: v.variant, pieces: v.pieces, workOrders: v.workOrders.size, orders: v.orders.size,
    })),
    log: evs.slice().reverse().slice(0, 20000).map((e) => ({
      at: e.at, barcode: e.barcode || "", cartonNumber: e.cartonNumber || "", moNumber: e.moNumber || "", customerName: e.customerName || "",
      woNumber: e.woNumber, product: e.product, variant: e.variant, qty: e.qty, units: compactRanges(e.units),
      by: e.personName || "Unknown", byEmployeeId: e.personEmployeeId || "", source: e.source || "",
    })),
  };
}

module.exports = { buildStageReport, reportWindow, compactRanges, MAX_SPAN_DAYS };
