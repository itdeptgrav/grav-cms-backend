// services/manufacturing/cuttingOverview.js — THE CUTTING OVERVIEW, IN ONE READ
//
// (16 Oct 2026, owner: "make the cutting dashboard overview like the
// marketing app one".) The marketing overview is one server summary drawn
// as a KPI strip, a dominant chart, an attention rail and a table. This is
// cutting's: built from `CuttingMasterRecord` — one document per cutting
// master per IST day, each entry a cut session with its units and its
// moment — so every figure is a recorded cut, never a reconstruction.
//
//   days     every day of the range, zero where nobody recorded a cut (a
//            record that does not exist IS a day of no recorded cutting)
//   hours    the shift's buckets (services/manufacturing/shiftHours), for
//            reading one day hour by hour
//   people   who cut, how much, on how many work orders and days
//   workOrders  what was cut, by whom, last when — plus, read by the route,
//            the work order's quantity and its cut-so-far
//   totals   pieces, sessions, work orders, people, active days, peak day
//
// Pure (`summarise`); the route reads the records and the work orders.
"use strict";

const shift = require("./shiftHours");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`), i = 0; d <= end && i < 400; d.setUTCDate(d.getUTCDate() + 1), i++) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** The range asked for, bounded: a day, at most 92 days, `to` not before `from`. */
function rangeOf(q = {}, today) {
  const to = DAY.test(String(q.to || "")) ? String(q.to) : today;
  let from = DAY.test(String(q.from || "")) ? String(q.from) : to;
  if (from > to) from = to;
  const days = daysBetween(from, to);
  if (days.length > 92) return { from: days[days.length - 92], to, days: 92 };
  return { from, to, days: days.length };
}

function summarise(records, range) {
  const buckets = shift.shiftBuckets();
  const days = new Map(daysBetween(range.from, range.to).map((d) => [d, { date: d, pieces: 0, sessions: 0, people: new Set() }]));
  const hours = buckets.map((b) => ({ key: b.key, label: b.label, short: b.short, outside: b.outside, pieces: 0, sessions: 0 }));
  const people = new Map();
  const wos = new Map();
  let pieces = 0, sessions = 0;

  for (const r of records || []) {
    const day = days.get(r.date);
    if (!day) continue;
    const pid = String(r.employeeId);
    if (!people.has(pid)) people.set(pid, { employeeId: pid, name: r.employeeName || "", biometricId: r.biometricId || "", designation: r.designation || "", pieces: 0, sessions: 0, days: new Set(), workOrders: new Set(), lastAt: null });
    const p = people.get(pid);
    for (const e of r.entries || []) {
      const q = Math.max(0, Math.round(Number(e.quantityCut) || 0));
      if (!q) continue;
      pieces += q; sessions += 1;
      day.pieces += q; day.sessions += 1; day.people.add(pid);
      p.pieces += q; p.sessions += 1; p.days.add(r.date);
      const at = e.timestamp ? new Date(e.timestamp) : null;
      if (at && !Number.isNaN(at.getTime())) {
        const h = hours[shift.bucketIndexOf(at)];
        h.pieces += q; h.sessions += 1;
        if (!p.lastAt || at > p.lastAt) p.lastAt = at;
      }
      const wk = String(e.woId || e.woNumber || "");
      if (wk) {
        p.workOrders.add(wk);
        if (!wos.has(wk)) wos.set(wk, { woId: e.woId ? String(e.woId) : null, woNumber: e.woNumber || "", product: e.stockItemName || "", variant: e.variants || "", pieces: 0, sessions: 0, people: new Set(), lastAt: null });
        const w = wos.get(wk);
        w.pieces += q; w.sessions += 1; w.people.add(r.employeeName || "");
        if (at && (!w.lastAt || at > w.lastAt)) w.lastAt = at;
      }
    }
  }

  const dayList = [...days.values()].map((d) => ({ date: d.date, pieces: d.pieces, sessions: d.sessions, people: d.people.size }));
  const active = dayList.filter((d) => d.pieces > 0);
  const peak = active.reduce((b, d) => (!b || d.pieces > b.pieces ? d : b), null);
  return {
    range,
    days: dayList,
    hours,
    totals: {
      pieces, sessions,
      workOrders: wos.size,
      people: people.size,
      activeDays: active.length,
      perActiveDay: active.length ? Math.round(pieces / active.length) : 0,
      peakDay: peak ? { date: peak.date, pieces: peak.pieces } : null,
    },
    people: [...people.values()]
      .map((p) => ({ ...p, days: p.days.size, workOrders: p.workOrders.size, share: pieces ? Math.round((p.pieces / pieces) * 1000) / 10 : 0 }))
      .sort((a, b) => b.pieces - a.pieces),
    workOrders: [...wos.values()]
      .map((w) => ({ ...w, people: [...w.people].filter(Boolean) }))
      .sort((a, b) => (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0)),
  };
}

module.exports = { summarise, rangeOf, daysBetween };
