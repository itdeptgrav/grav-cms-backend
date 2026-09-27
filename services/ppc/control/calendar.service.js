// services/ppc/control/calendar.service.js
//
// THE TARGET CALENDAR (26 Sep 2026). One month, day by day: what PPC's
// targets ask of the floor on each date, what the floor gave, how loaded
// each department is against IE's standard, and which orders are due — so
// the PPC person can read a month's pressure at a glance and open any day.
//
// Every figure is derived from the same books the rest of the control
// center reads: the company's active targets (`PpcOrderTarget`), each
// department's completion events (ledger.service through orders.snapshot),
// IE's department standards (capacity a day) and the order headers
// (delivery deadline). Nothing is typed in.
//
// A day's PRESSURE is the busiest department's expected pieces against its
// capacity that day:
//   free        no target covers the day
//   light       under 60% of capacity
//   normal      60–100%
//   heavy       100–120%   (asked for more than the standard says it can do)
//   overloaded  over 120%
//   unknown     a target covers the day but IE has set no standard for it
// A day's ACHIEVEMENT (past days and today) is done against expected:
//   achieved ≥100%, on_track ≥85%, behind <85%, not_started 0 with expected>0.
"use strict";

const PpcOrderTarget = require("../../../models/CMS_Models/PPC/PpcOrderTarget");
const orders = require("./orders.service");
const { DEPARTMENTS, DEPARTMENT_META } = require("./ledger.service");
const ev = require("../orderTargets.evaluate");
const standards = require("../../industrialEngineering/departmentStandards.service");

const IST_MS = 330 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => ev.dayOf(new Date());

/** The first and last IST day of "YYYY-MM"; this month when absent or malformed. */
function monthBounds(month) {
  let y, m;
  const hit = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (hit) { y = Number(hit[1]); m = Number(hit[2]); }
  else { const t = todayKey().split("-").map(Number); y = t[0]; m = t[1]; }
  if (m < 1 || m > 12) { const t = todayKey().split("-").map(Number); y = t[0]; m = t[1]; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { key: `${y}-${pad(m)}`, first: `${y}-${pad(m)}-01`, last: `${y}-${pad(m)}-${pad(last)}`, days: last, year: y, month: m };
}

function pressureOf(pct, hasTargets, capacityKnown) {
  if (!hasTargets) return "free";
  if (!capacityKnown) return "unknown";
  if (pct < 60) return "light";
  if (pct <= 100) return "normal";
  if (pct <= 120) return "heavy";
  return "overloaded";
}
function achievementOf(expected, done, isPast) {
  if (!expected) return done > 0 ? "achieved" : "none";
  const pct = (done / expected) * 100;
  if (pct >= 100) return "achieved";
  if (!isPast) return done === 0 ? "not_started" : pct >= 85 ? "on_track" : "behind";
  return done === 0 ? "missed" : pct >= 85 ? "on_track" : "behind";
}

async function calendar(companyId, q = {}) {
  const b = monthBounds(q.month);
  const today = todayKey();
  const start = ev.instant(b.first, "00:00");
  const end = ev.instant(ev.shiftDay(b.last, 1), "00:00");

  /* the order book, this month's events, the targets touching the month */
  const [snap, stdMap] = await Promise.all([
    orders.snapshot(companyId, { asOfDay: today <= b.last && today >= b.first ? today : b.last, start, end }),
    standards.standardsFor(companyId).catch(() => new Map()),
  ]);
  const rows = orders.summariseOrders(snap);
  const rowByMo = new Map(rows.map((r) => [r.moId, r]));
  const targets = (snap.targets || []).filter((t) => t.status === "active" && t.from <= b.last && t.to >= b.first);
  const capacity = new Map(DEPARTMENTS.map((d) => [d, ev.capacityAt(stdMap.get(d) || null)]));

  /* deliveries by day */
  const dueByDay = new Map();
  for (const r of rows) {
    if (!r.deliveryDate) continue;
    const d = ev.dayOf(r.deliveryDate);
    if (d < b.first || d > b.last) continue;
    if (!dueByDay.has(d)) dueByDay.set(d, []);
    dueByDay.get(d).push({ moId: r.moId, moNumber: r.moNumber, customerName: r.customerName, quantity: r.quantity, produced: r.produced, remaining: r.remaining, dispatched: r.dispatched, risk: r.risk, productionStatus: r.productionStatus, progressPct: r.progressPct });
  }

  /* per target, the days it covers inside the month, with expected and done */
  const days = new Map();
  for (let d = b.first, i = 0; d <= b.last && i < 32; d = ev.shiftDay(d, 1), i++) {
    days.set(d, { date: d, targets: [], byDept: new Map() });
  }
  for (const t of targets) {
    const events = snap.eventsByMo.get(String(t.manufacturingOrderId))?.get(t.department) || [];
    const perDay = Math.round(ev.expectedPerDay(t));
    const r = rowByMo.get(String(t.manufacturingOrderId));
    for (const d of ev.targetDays(t)) {
      const day = days.get(d); if (!day) continue;
      const done = ev.doneOn(events, t, d);
      const isPast = d < today;
      const status = d > today ? "planned" : achievementOf(perDay, done, isPast);
      day.targets.push({
        targetId: String(t._id), moId: String(t.manufacturingOrderId), moNumber: t.moNumber || r?.moNumber || "", customerName: t.customerName || r?.customerName || "",
        department: t.department, label: DEPARTMENT_META[t.department]?.label || t.department, kind: t.kind, pieces: t.pieces,
        hoursFrom: t.hoursFrom || "", hoursTo: t.hoursTo || "", from: t.from, to: t.to,
        expected: perDay, done, short: Math.max(0, perDay - done), pct: perDay ? Math.round((done / perDay) * 100) : null, status,
        description: ev.describeTarget(t), orderRisk: r?.risk || "", orderDelivery: r?.deliveryDate || null,
      });
      const cur = day.byDept.get(t.department) || { department: t.department, label: DEPARTMENT_META[t.department]?.label || t.department, expected: 0, done: 0, targets: 0, orders: new Set() };
      cur.expected += perDay; cur.done += done; cur.targets += 1; cur.orders.add(String(t.manufacturingOrderId));
      day.byDept.set(t.department, cur);
    }
  }

  /* fold each day */
  const out = [];
  for (const day of days.values()) {
    const depts = [...day.byDept.values()].map((x) => {
      const cap = capacity.get(x.department);
      const loadPct = cap ? Math.round((x.expected / cap.perDay) * 100) : null;
      return { department: x.department, label: x.label, expected: x.expected, done: x.done, short: Math.max(0, x.expected - x.done), targets: x.targets, orders: x.orders.size, capacityPerDay: cap?.perDay ?? null, loadPct, pct: x.expected ? Math.round((x.done / x.expected) * 100) : null };
    }).sort((a, b2) => DEPARTMENT_META[a.department].order - DEPARTMENT_META[b2.department].order);
    const expected = depts.reduce((n, x) => n + x.expected, 0);
    const done = depts.reduce((n, x) => n + x.done, 0);
    const known = depts.filter((x) => x.loadPct != null);
    const busiest = known.sort((a, b2) => b2.loadPct - a.loadPct)[0] || null;
    const isPast = day.date < today, isToday = day.date === today;
    const deliveries = dueByDay.get(day.date) || [];
    const pressure = pressureOf(busiest?.loadPct ?? 0, depts.length > 0, known.length > 0);
    out.push({
      date: day.date, weekday: new Date(`${day.date}T00:00:00Z`).getUTCDay(), isToday, isPast, isFuture: day.date > today,
      expected, done, short: Math.max(0, expected - done), pct: expected ? Math.round((done / expected) * 100) : null,
      achievement: day.date > today ? "planned" : achievementOf(expected, done, isPast),
      pressure, pressurePct: busiest?.loadPct ?? null, pressureDepartment: busiest?.department || null,
      targets: day.targets.sort((a, b2) => DEPARTMENT_META[a.department].order - DEPARTMENT_META[b2.department].order || a.moNumber.localeCompare(b2.moNumber)),
      departments: depts.sort((a, b2) => DEPARTMENT_META[a.department].order - DEPARTMENT_META[b2.department].order),
      orders: new Set(day.targets.map((t) => t.moId)).size,
      deliveries, deliveriesAtRisk: deliveries.filter((x) => x.productionStatus !== "completed" && (x.risk === "overdue" || x.risk === "at_risk" || x.remaining > 0)).length,
    });
  }

  const withTargets = out.filter((d) => d.targets.length);
  const past = out.filter((d) => !d.isFuture && d.expected > 0);
  const totals = {
    days: out.length, daysWithTargets: withTargets.length, targets: targets.length, orders: new Set(targets.map((t) => String(t.manufacturingOrderId))).size,
    expected: out.reduce((n, d) => n + d.expected, 0), done: out.reduce((n, d) => n + d.done, 0),
    expectedToDate: past.reduce((n, d) => n + d.expected, 0), doneToDate: past.reduce((n, d) => n + d.done, 0),
    achievedDays: past.filter((d) => d.achievement === "achieved").length, behindDays: past.filter((d) => d.achievement === "behind" || d.achievement === "missed").length,
    heavyDays: out.filter((d) => d.pressure === "heavy").length, overloadedDays: out.filter((d) => d.pressure === "overloaded").length,
    deliveries: out.reduce((n, d) => n + d.deliveries.length, 0), deliveriesAtRisk: out.reduce((n, d) => n + d.deliveriesAtRisk, 0),
  };
  totals.achievementPct = totals.expectedToDate ? Math.round((totals.doneToDate / totals.expectedToDate) * 100) : null;

  /* per department over the month: expected, done, capacity, the loaded days */
  const departments = DEPARTMENTS.map((d) => {
    const cap = capacity.get(d);
    const dd = out.map((x) => x.departments.find((y) => y.department === d)).filter(Boolean);
    const expected = dd.reduce((n, x) => n + x.expected, 0), done = dd.reduce((n, x) => n + x.done, 0);
    return { department: d, label: DEPARTMENT_META[d].label, expected, done, days: dd.length, capacityPerDay: cap?.perDay ?? null, overDays: dd.filter((x) => x.loadPct != null && x.loadPct > 100).length, pct: expected ? Math.round((done / expected) * 100) : null };
  });

  /* the orders a target may be set on from a day: active ones, with what
     the drawer needs to open QuickTarget */
  const activeOrders = rows.filter((r) => r.productionStatus !== "completed").map((r) => ({ moId: r.moId, moNumber: r.moNumber, customerName: r.customerName, quantity: r.quantity, produced: r.produced, remaining: r.remaining, deliveryDate: r.deliveryDate, risk: r.risk, targetStatus: r.targetStatus })).sort((a, b2) => a.moNumber.localeCompare(b2.moNumber));

  return {
    month: b.key, first: b.first, last: b.last, today, generatedAt: new Date(),
    orders: activeOrders,
    capacityKnown: [...capacity.values()].some(Boolean),
    totals, departments, days: out,
  };
}

module.exports = { calendar, monthBounds, pressureOf, achievementOf };
