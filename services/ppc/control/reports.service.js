// services/ppc/control/reports.service.js
//
// PPC'S REPORTS, COMPUTED SERVER-SIDE FROM THE LEDGER.
//
// Hour-wise, day-wise, per department, per order, per work order, per product
// and variant, per person, over any date-time range; target against
// achievement; efficiency against IE's standard; delay and shortfall. Every
// report starts from the same snapshot the order list is built from, so a
// figure on a report is the figure on the list.
//
// Hours are the factory's shift buckets (services/manufacturing/shiftHours.js:
// 09:30–18:30 IST in nine buckets, plus before and after) — the same buckets
// the finishing and packaging overviews use. Days are IST days.
//
// Targets: a per-hour target expects its pieces in every hour of its window;
// a per-day or total target expects its day's pieces spread evenly over the
// nine shift hours (or over its own window when it names one). Nothing here
// invents a target where PPC set none — a row with no target says so.
"use strict";

const PpcOrderTarget = require("../../../models/CMS_Models/PPC/PpcOrderTarget");
const ledger = require("./ledger.service");
const orders = require("./orders.service");
const ev = require("../orderTargets.evaluate");
const shift = require("../../manufacturing/shiftHours");
const standards = require("../../industrialEngineering/departmentStandards.service");

const { DEPARTMENTS, DEPARTMENT_META, FINISHING, isId, sum, lastAt, firstAt, groupBy } = ledger;
const { pct, todayKey } = orders;
const DAY_MS = 86400000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const round1 = (n) => Math.round(n * 10) / 10;

/* ── ranges ──────────────────────────────────────────────────────────────── */

/** `{ start, end, from, to, fromLabel, toLabel }` for a day range or a date-time range. */
function rangeOf(q = {}) {
  const today = todayKey();
  let start, end, from, to;
  if (q.fromAt || q.toAt) {
    /* A date-time range: ISO or "YYYY-MM-DDTHH:MM" read as IST wall-clock. */
    start = parseAt(q.fromAt) || shift.istDayWindow(today).start;
    end = parseAt(q.toAt) || new Date();
    if (end <= start) end = new Date(start.getTime() + DAY_MS);
    from = shift.istDayKeyOf(start); to = shift.istDayKeyOf(new Date(end.getTime() - 1));
  } else {
    to = YMD.test(String(q.to || "")) ? q.to : (YMD.test(String(q.date || "")) ? q.date : today);
    from = YMD.test(String(q.from || "")) ? q.from : (YMD.test(String(q.date || "")) ? q.date : to);
    if (from > to) [from, to] = [to, from];
    /* Cap at 186 days like the stage report does. */
    const span = (shift.istDayWindow(to).start - shift.istDayWindow(from).start) / DAY_MS;
    if (span > 186) from = shift.shiftDayKey(to, -186);
    start = shift.istDayWindow(from).start; end = shift.istDayWindow(to).end;
  }
  return { start, end, from, to, days: dayKeys(from, to), precise: Boolean(q.fromAt || q.toAt), fromAt: start.toISOString(), toAt: end.toISOString() };
}
function parseAt(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) { const [d, t] = s.split("T"); return ev.instant(d, t.slice(0, 5)); }
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d;
}
function dayKeys(from, to) { const out = []; let d = from; while (d <= to && out.length < 400) { out.push(d); d = shift.shiftDayKey(d, 1); } return out; }

/* ── scope: which work orders a report is about ──────────────────────────── */

function scopeFilter(q = {}) {
  const f = {};
  if (q.moId && isId(q.moId)) f.moId = String(q.moId);
  if (q.woId && isId(q.woId)) f.woId = String(q.woId);
  if (q.product) f.product = String(q.product).toLowerCase();
  if (q.variant) f.variant = String(q.variant).toLowerCase();
  if (q.customer) f.customer = String(q.customer).toLowerCase();
  if (q.department && DEPARTMENTS.includes(q.department)) f.department = q.department;
  if (q.orderType === "bulk" || q.orderType === "person_wise") f.orderType = q.orderType;
  return f;
}
function woMatches(w, h, f) {
  if (f.woId && w.id !== f.woId) return false;
  if (f.moId && w.moId !== f.moId) return false;
  if (f.product && !(w.product.toLowerCase().includes(f.product) || w.reference.toLowerCase().includes(f.product) || (w.stockItemId === f.product))) return false;
  if (f.variant && !w.variant.toLowerCase().includes(f.variant)) return false;
  if (f.customer && !(h?.customerName || w.customerName).toLowerCase().includes(f.customer)) return false;
  if (f.orderType && h?.orderType !== f.orderType) return false;
  return true;
}
/** Events of the snapshot inside the scope: `Map department → events`. */
function scoped(snap, f) {
  const keep = new Set(snap.index.list.filter((w) => woMatches(w, snap.headers.get(w.moId), f)).map((w) => w.id));
  const moKeep = new Set([...keep].map((id) => snap.index.byId.get(id).moId));
  const out = new Map();
  for (const [d, list] of snap.events) {
    if (f.department && d !== f.department) continue;
    out.set(d, list.filter((e) => (e.woId ? keep.has(e.woId) : (!f.woId && !f.product && !f.variant && moKeep.has(e.moId)))));
  }
  return { events: out, woIds: keep, moIds: moKeep };
}

/* ── targets, by day and by hour ─────────────────────────────────────────── */

/** Targets that applied on a day (active then, whatever they are now). */
function targetsOn(targets, department, ymd, moIds = null) {
  return targets.filter((t) => t.department === department && (!moIds || moIds.has(String(t.manufacturingOrderId)))
    && (t.status === "active" || (t.endedAt && shift.istDayKeyOf(t.endedAt) > ymd))
    && ev.targetDays(t).includes(ymd));
}
const expectedDay = (ts) => ts.reduce((n, t) => n + ev.expectedPerDay(t), 0);
const minutesOf = (hhmm) => { const [h, m] = String(hhmm || "").split(":").map(Number); return h * 60 + m; };
/** What a set of targets expects in one shift bucket. */
function expectedInBucket(ts, bucket) {
  if (bucket.outside) return 0;
  const bStart = minutesOf(bucket.key), bEnd = bStart + 60;
  let n = 0;
  for (const t of ts) {
    const wStart = t.hoursFrom ? minutesOf(t.hoursFrom) : shift.SHIFT_START_MIN;
    const wEnd = t.hoursTo ? minutesOf(t.hoursTo) : shift.SHIFT_END_MIN;
    const overlap = Math.max(0, Math.min(bEnd, wEnd) - Math.max(bStart, wStart)) / 60;
    if (!overlap) continue;
    if (t.kind === "per_hour") n += t.pieces * overlap;
    else n += (ev.expectedPerDay(t) / Math.max(1, (wEnd - wStart) / 60)) * overlap;
  }
  return n;
}

/* ── hourly ──────────────────────────────────────────────────────────────── */

async function hourly(companyId, q = {}) {
  const date = YMD.test(String(q.date || "")) ? q.date : todayKey();
  const day = shift.istDayWindow(date);
  const f = scopeFilter(q);
  const snap = await orders.snapshot(companyId, { asOfDay: date, start: day.start, end: day.end });
  const { events, moIds } = scoped(snap, f);
  const stds = await standards.standardsFor(companyId);
  const buckets = shift.shiftBuckets();
  const now = new Date();
  const isToday = date === todayKey();
  const nowMin = shift.istMinutesOf(now);
  const depts = f.department ? [f.department] : DEPARTMENTS;

  const departments = depts.map((d) => {
    const list = events.get(d) || [];
    const ts = targetsOn(snap.targets, d, date, f.moId ? moIds : null);
    const std = stds.get(d) || null;
    const byBucket = buckets.map(() => []);
    for (const e of list) byBucket[shift.bucketIndexOf(e.at)].push(e);
    /* Bucket targets are rounded on the CUMULATIVE line, so nine thirds of
       100 add up to 100 and not 99. */
    let cumT = 0, cumA = 0, exactCum = 0;
    const hours = buckets.map((b, i) => {
      const es = byBucket[i];
      const actual = sum(es);
      exactCum += expectedInBucket(ts, b);
      const target = Math.round(exactCum) - cumT;
      cumT += target; cumA += actual;
      const bStart = b.outside ? null : minutesOf(b.key);
      const elapsedMin = b.outside ? null : isToday ? Math.max(0, Math.min(60, nowMin - bStart)) : 60;
      const future = isToday && bStart != null && nowMin < bStart;
      const eff = std && elapsedMin ? { earnedMinutes: Math.round(actual * std.samMinutesPerPiece), availableMinutes: Math.round(std.operators * elapsedMin), pct: std.operators * elapsedMin ? Math.round((actual * std.samMinutesPerPiece) / (std.operators * elapsedMin) * 100) : null } : null;
      return {
        key: b.key, label: b.label, short: b.short, outside: b.outside, future,
        target, actual, cumulativeTarget: cumT, cumulativeActual: cumA, difference: actual - target, cumulativeDifference: cumA - cumT,
        achievementPct: target ? Math.round((actual / target) * 100) : null, efficiency: eff,
        orders: new Set(es.map((e) => e.moId)).size, workOrders: new Set(es.map((e) => e.woId).filter(Boolean)).size,
        products: [...new Set(es.map((e) => snap.index.byId.get(e.woId)?.product).filter(Boolean))], variants: [...new Set(es.map((e) => { const w = snap.index.byId.get(e.woId); return w ? `${w.product}${w.variant ? ` · ${w.variant}` : ""}` : null; }).filter(Boolean))],
        people: [...groupBy(es, (e) => e.personName || e.personKey || "").entries()].filter(([k]) => k).map(([name, l]) => ({ name, pieces: sum(l) })).sort((a, b) => b.pieces - a.pieces),
      };
    });
    const totalTarget = hours.reduce((n, h) => n + h.target, 0), totalActual = sum(list);
    const elapsedShiftH = isToday ? Math.max(0, Math.min(shift.SHIFT_HOURS, (nowMin - shift.SHIFT_START_MIN) / 60)) : shift.SHIFT_HOURS;
    const pace = elapsedShiftH > 0 ? round1(totalActual / elapsedShiftH) : 0;
    const peak = hours.filter((h) => h.actual > 0).sort((a, b) => b.actual - a.actual)[0] || null;
    return {
      department: d, label: DEPARTMENT_META[d].label, hasTarget: ts.length > 0, targets: ts.length,
      totals: { target: totalTarget, actual: totalActual, difference: totalActual - totalTarget, achievementPct: totalTarget ? Math.round((totalActual / totalTarget) * 100) : null, remaining: Math.max(0, totalTarget - totalActual), pacePerHour: pace, expectedEndOfDay: isToday ? Math.round(totalActual + pace * Math.max(0, shift.SHIFT_HOURS - elapsedShiftH)) : totalActual, requiredPerRemainingHour: isToday && totalTarget > totalActual && shift.SHIFT_HOURS - elapsedShiftH > 0 ? Math.ceil((totalTarget - totalActual) / (shift.SHIFT_HOURS - elapsedShiftH)) : null, peakHour: peak ? { label: peak.label, actual: peak.actual } : null, orders: new Set(list.map((e) => e.moId)).size, workOrders: new Set(list.map((e) => e.woId).filter(Boolean)).size, people: new Set(list.map((e) => e.personName || e.personKey).filter(Boolean)).size,
        efficiency: std ? ev.efficiencyOf(totalActual, { hoursFrom: "", hoursTo: "" }, date, std, now) : null, capacityPerDay: std?.capacity?.perDay ?? null, capacityPerHour: std?.capacity?.perHour ?? null },
      hours,
      orders: [...groupBy(list, (e) => e.moId).entries()].map(([moId, l]) => { const h = snap.headers.get(moId); return { moId, moNumber: h?.moNumber || "", poNumber: h?.poNumber || "", customerName: h?.customerName || "", pieces: sum(l), workOrders: new Set(l.map((e) => e.woId).filter(Boolean)).size }; }).sort((a, b) => b.pieces - a.pieces),
    };
  });
  return { date, shift: shift.SHIFT, isToday, generatedAt: now, scope: f, departments, buckets: buckets.map((b) => ({ key: b.key, label: b.label, short: b.short, outside: b.outside })) };
}

/* ── daily ───────────────────────────────────────────────────────────────── */

async function daily(companyId, q = {}) {
  const r = rangeOf({ ...q, fromAt: undefined, toAt: undefined });
  const f = scopeFilter(q);
  const snap = await orders.snapshot(companyId, { asOfDay: r.to });
  const { events, moIds } = scoped(snap, f);
  const stds = await standards.standardsFor(companyId);
  const depts = f.department ? [f.department] : DEPARTMENTS;
  /* completion per order needs ALL-TIME production events, which the snapshot has */
  const prodByMo = groupBy(events.get("production") || [], (e) => e.moId);
  const orderQty = new Map();
  for (const [moId, wos] of snap.index.byMo) orderQty.set(moId, wos.filter((w) => w.status !== "cancelled").reduce((n, w) => n + w.quantity, 0));

  let cumT = 0, cumA = 0;
  const days = r.days.map((ymd) => {
    const w = shift.istDayWindow(ymd);
    const inDay = (l) => l.filter((e) => e.at >= w.start && e.at < w.end);
    const perDept = depts.map((d) => {
      const l = inDay(events.get(d) || []);
      const ts = targetsOn(snap.targets, d, ymd, f.moId ? moIds : null);
      const target = Math.round(expectedDay(ts));
      const actual = sum(l);
      const std = stds.get(d) || null;
      const eff = std ? ev.efficiencyOf(actual, { hoursFrom: "", hoursTo: "" }, ymd, std, new Date()) : null;
      return { department: d, label: DEPARTMENT_META[d].label, target, actual, difference: actual - target, achievementPct: target ? Math.round((actual / target) * 100) : null, targets: ts.length, orders: new Set(l.map((e) => e.moId)).size, workOrders: new Set(l.map((e) => e.woId).filter(Boolean)).size, people: new Set(l.map((e) => e.personName || e.personKey).filter(Boolean)).size, efficiency: eff, capacityPerDay: std?.capacity?.perDay ?? null, utilisationPct: std?.capacity?.perDay ? Math.round((actual / std.capacity.perDay) * 100) : null };
    });
    /* production as the day's headline when no single department is asked for */
    const head = f.department ? perDept[0] : perDept.find((x) => x.department === "production");
    const target = f.department ? head.target : perDept.reduce((n, x) => n + x.target, 0);
    const actual = f.department ? head.actual : head.actual;
    cumT += target; cumA += actual;
    /* orders completed (sewing reached the quantity) on this day */
    const completedOrders = [];
    for (const [moId, l] of prodByMo) {
      const qty = orderQty.get(moId) || 0; if (!qty) continue;
      const sorted = [...l].sort((a, b) => a.at - b.at);
      let n = 0, doneAt = null;
      for (const e of sorted) { n += e.qty; if (n >= qty) { doneAt = e.at; break; } }
      if (doneAt && doneAt >= w.start && doneAt < w.end) completedOrders.push({ moId, moNumber: snap.headers.get(moId)?.moNumber || "", customerName: snap.headers.get(moId)?.customerName || "" });
    }
    const allDay = depts.flatMap((d) => inDay(events.get(d) || []));
    const woDone = [];
    for (const [woId, l] of groupBy(events.get("production") || [], (e) => e.woId)) { const wo = snap.index.byId.get(woId); if (!wo?.quantity) continue; const s = [...l].sort((a, b) => a.at - b.at); let n = 0; for (const e of s) { n += e.qty; if (n >= wo.quantity) { if (e.at >= w.start && e.at < w.end) woDone.push({ woId, number: wo.number, product: wo.product, variant: wo.variant }); break; } } }
    return {
      date: ymd, weekday: new Date(w.start.getTime() + shift.IST_OFFSET_MS).getUTCDay(),
      target, actual, difference: actual - target, achievementPct: target ? Math.round((actual / target) * 100) : null, shortfall: Math.max(0, target - actual),
      cumulativeTarget: cumT, cumulativeActual: cumA,
      activeOrders: new Set(allDay.map((e) => e.moId)).size, ordersCompleted: completedOrders, workOrdersCompleted: woDone,
      departments: perDept,
      efficiency: head.efficiency,
    };
  });
  const active = days.filter((d) => d.actual > 0);
  return {
    ...r, scope: f, headline: f.department ? DEPARTMENT_META[f.department].label : "Production (sewing)",
    totals: { target: cumT, actual: cumA, difference: cumA - cumT, achievementPct: cumT ? Math.round((cumA / cumT) * 100) : null, activeDays: active.length, avgPerActiveDay: active.length ? Math.round(cumA / active.length) : 0, bestDay: active.sort((a, b) => b.actual - a.actual)[0]?.date || null,
      departments: depts.map((d) => ({ department: d, label: DEPARTMENT_META[d].label, target: days.reduce((n, x) => n + x.departments.find((y) => y.department === d).target, 0), actual: days.reduce((n, x) => n + x.departments.find((y) => y.department === d).actual, 0) })).map((x) => ({ ...x, achievementPct: x.target ? Math.round((x.actual / x.target) * 100) : null })) },
    days,
  };
}

/* ── one department, in full ─────────────────────────────────────────────── */

async function departmentPage(companyId, department, q = {}) {
  if (!DEPARTMENTS.includes(department)) return null;
  const date = YMD.test(String(q.date || "")) ? q.date : todayKey();
  const [snap, stds, hour, trend] = await Promise.all([
    orders.snapshot(companyId, { asOfDay: date }), standards.standardsFor(companyId),
    hourly(companyId, { date, department }), daily(companyId, { from: shift.shiftDayKey(date, -13), to: date, department }),
  ]);
  const std = stds.get(department) || null;
  const rows = orders.summariseOrders(snap);
  const day = shift.istDayWindow(date);
  const list = snap.events.get(department) || [];
  const todayEvents = list.filter((e) => e.at >= day.start && e.at < day.end);
  const ts = targetsOn(snap.targets, department, date);
  const h = hour.departments[0];

  /* orders this department is involved in: has a target here, has work here, or is next here */
  const active = rows.filter((r) => r.productionStatus !== "completed" && (r.currentStage === department || r.nextStage === department || r.departments.find((d) => d.department === department).done > 0 || snap.targets.some((t) => t.department === department && t.status === "active" && String(t.manufacturingOrderId) === r.moId)));
  const activeRows = active.map((r) => {
    const d = r.departments.find((x) => x.department === department);
    const t = snap.targets.find((x) => x.department === department && x.status === "active" && String(x.manufacturingOrderId) === r.moId) || null;
    const evaluated = t ? ev.evaluateTarget(t, (snap.eventsByMo.get(r.moId)?.get(department)) || [], date, { doneOverall: d.done, orderQuantity: r.quantity, standard: std }) : null;
    const wos = (snap.index.byMo.get(r.moId) || []).filter((w) => w.status !== "cancelled");
    return { moId: r.moId, moNumber: r.moNumber, poNumber: r.poNumber, customerName: r.customerName, orderType: r.orderType, deliveryDate: r.deliveryDate, risk: r.risk, quantity: r.quantity, done: d.done, remaining: d.remaining, pct: d.pct, today: d.today, isCurrent: r.currentStage === department, isNext: r.nextStage === department,
      products: [...new Set(wos.map((w) => w.product))], variants: wos.length, workOrders: wos.map((w) => ({ id: w.id, number: w.number, product: w.product, variant: w.variant, quantity: w.quantity })),
      target: evaluated ? { targetId: String(t._id), description: ev.describeTarget(t), status: evaluated.status, today: evaluated.today, toDate: evaluated.toDate, span: evaluated.span, advice: evaluated.advice } : null,
      status: evaluated ? evaluated.status : (d.done >= r.quantity && r.quantity ? "complete" : d.done > 0 ? "working" : "waiting") };
  }).sort((a, b) => (a.target?.status === "behind" ? -1 : 0) - (b.target?.status === "behind" ? -1 : 0) || b.today - a.today);
  const delayed = activeRows.filter((r) => r.target?.status === "behind" || r.risk === "overdue" || r.risk === "at_risk");

  const evaluatedTargets = snap.targets.filter((t) => t.department === department).sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt)).map((t) => { const l = snap.eventsByMo.get(String(t.manufacturingOrderId))?.get(department) || []; const r = ev.evaluateTarget(t, l, date, { doneOverall: sum(l), orderQuantity: t.orderQuantity, standard: std }); return { ...r, moId: String(t.manufacturingOrderId), moNumber: t.moNumber, customerName: t.customerName, description: ev.describeTarget(t), assignedBy: t.assignedBy?.name || "", assignedAt: t.assignedAt, endStatus: t.status, endReason: t.endReason || "", endedAt: t.endedAt || null }; });

  const byProduct = [...groupBy(list, (e) => { const w = snap.index.byId.get(e.woId); return w ? `${w.stockItemId || w.product}` : null; }).entries()].map(([, l]) => { const w = snap.index.byId.get(l[0].woId); const variants = [...groupBy(l, (e) => snap.index.byId.get(e.woId)?.variant || "—").entries()].map(([variant, vl]) => ({ variant, pieces: sum(vl), today: sum(vl.filter((e) => e.at >= day.start && e.at < day.end)), quantity: [...new Set(vl.map((e) => e.woId))].reduce((n, id) => n + (snap.index.byId.get(id)?.quantity || 0), 0) })); return { product: w?.product || "", reference: w?.reference || "", image: w?.image || null, pieces: sum(l), today: sum(l.filter((e) => e.at >= day.start && e.at < day.end)), quantity: [...new Set(l.map((e) => e.woId))].reduce((n, id) => n + (snap.index.byId.get(id)?.quantity || 0), 0), variants }; }).sort((a, b) => b.today - a.today || b.pieces - a.pieces);
  const byWo = [...groupBy(list, (e) => e.woId).entries()].filter(([k]) => k).map(([woId, l]) => { const w = snap.index.byId.get(woId); const h2 = snap.headers.get(w.moId); return { woId, number: w.number, product: w.product, variant: w.variant, moId: w.moId, moNumber: h2?.moNumber || "", customerName: h2?.customerName || "", quantity: w.quantity, done: ledger.unitsOf(l), today: sum(l.filter((e) => e.at >= day.start && e.at < day.end)), lastAt: lastAt(l) }; }).map((x) => ({ ...x, remaining: Math.max(0, x.quantity - x.done), pct: pct(Math.min(x.done, x.quantity || x.done), x.quantity) })).sort((a, b) => b.today - a.today || (new Date(b.lastAt || 0) - new Date(a.lastAt || 0)));
  const people = [...groupBy(list, (e) => e.personName || e.personKey || "").entries()].filter(([k]) => k).map(([name, l]) => ({ name, total: sum(l), today: sum(l.filter((e) => e.at >= day.start && e.at < day.end)), lastAt: lastAt(l) })).sort((a, b) => b.today - a.today || b.total - a.total);

  return {
    department, label: DEPARTMENT_META[department].label, doneWord: DEPARTMENT_META[department].done, date, isToday: date === todayKey(), shift: shift.SHIFT,
    standard: std ? { samMinutesPerPiece: std.samMinutesPerPiece, operators: std.operators, hoursPerDay: std.hoursPerDay, efficiencyPct: std.efficiencyPct, capacityPerDay: std.capacity?.perDay ?? null, capacityPerHour: std.capacity?.perHour ?? null } : null,
    summary: { ...h.totals, targets: ts.length, activeOrders: active.length, delayedOrders: delayed.length, utilisationPct: std?.capacity?.perDay ? Math.round((h.totals.actual / std.capacity.perDay) * 100) : null, plannedLoad: Math.round(expectedDay(ts)), allTimePieces: sum(list), firstAt: firstAt(list), lastAt: lastAt(list),
      status: !ts.length ? "no_target" : h.totals.achievementPct == null ? "no_target" : h.totals.achievementPct >= 100 ? "achieved" : (() => { const exp = ts.reduce((n, t) => n + (ev.evaluateTarget(t, [], date).today?.expectedSoFar || 0), 0); return exp === 0 ? "not_started" : h.totals.actual >= exp * 0.85 ? "on_track" : "behind"; })() },
    hourly: h.hours, trend: trend.days.map((d) => ({ date: d.date, target: d.target, actual: d.actual, achievementPct: d.achievementPct, efficiency: d.efficiency })),
    activeOrders: activeRows, delayed, targets: evaluatedTargets, products: byProduct, workOrders: byWo, people,
  };
}

/* ── a date-time range ───────────────────────────────────────────────────── */

async function range(companyId, q = {}) {
  const r = rangeOf(q);
  const f = scopeFilter(q);
  const snap = await orders.snapshot(companyId, { asOfDay: r.to, start: r.start, end: r.end });
  const { events } = scoped(snap, f);
  const depts = f.department ? [f.department] : DEPARTMENTS;
  const all = depts.flatMap((d) => events.get(d) || []);
  const buckets = shift.shiftBuckets();
  const dept = (d) => { const l = events.get(d) || []; return { department: d, label: DEPARTMENT_META[d].label, pieces: sum(l), orders: new Set(l.map((e) => e.moId)).size, workOrders: new Set(l.map((e) => e.woId).filter(Boolean)).size, people: new Set(l.map((e) => e.personName || e.personKey).filter(Boolean)).size, firstAt: firstAt(l), lastAt: lastAt(l) }; };
  const perDept = depts.map(dept);
  const byOrder = [...groupBy(all, (e) => e.moId).entries()].map(([moId, l]) => { const h = snap.headers.get(moId); return { moId, moNumber: h?.moNumber || "", poNumber: h?.poNumber || "", customerName: h?.customerName || "", orderType: h?.orderType || "", pieces: sum(l), departments: depts.map((d) => ({ department: d, pieces: sum(l.filter((e) => e.department === d)) })) }; }).sort((a, b) => b.pieces - a.pieces);
  const byWo = [...groupBy(all, (e) => e.woId).entries()].filter(([k]) => k).map(([woId, l]) => { const w = snap.index.byId.get(woId); const h = snap.headers.get(w.moId); return { woId, number: w.number, product: w.product, reference: w.reference, variant: w.variant, quantity: w.quantity, moNumber: h?.moNumber || "", poNumber: h?.poNumber || "", customerName: h?.customerName || "", pieces: sum(l), departments: depts.map((d) => ({ department: d, pieces: sum(l.filter((e) => e.department === d)) })) }; }).sort((a, b) => b.pieces - a.pieces);
  const byVariant = [...groupBy(all, (e) => { const w = snap.index.byId.get(e.woId); return w ? `${w.stockItemId || w.product}|${w.variant}` : null; }).entries()].map(([, l]) => { const w = snap.index.byId.get(l[0].woId); return { product: w.product, reference: w.reference, variant: w.variant, size: w.size, colour: w.colour, pieces: sum(l), orders: new Set(l.map((e) => e.moId)).size, workOrders: new Set(l.map((e) => e.woId)).size, departments: depts.map((d) => ({ department: d, pieces: sum(l.filter((e) => e.department === d)) })) }; }).sort((a, b) => b.pieces - a.pieces);
  const byPerson = [...groupBy(all, (e) => e.personName || e.personKey || "").entries()].filter(([k]) => k).map(([name, l]) => ({ name, pieces: sum(l), departments: depts.map((d) => ({ department: d, pieces: sum(l.filter((e) => e.department === d)) })).filter((x) => x.pieces) })).sort((a, b) => b.pieces - a.pieces);
  const byHour = buckets.map((b, i) => ({ key: b.key, label: b.label, outside: b.outside, pieces: 0, departments: depts.map((d) => ({ department: d, pieces: 0 })) }));
  for (const e of all) { const i = shift.bucketIndexOf(e.at); byHour[i].pieces += e.qty; byHour[i].departments.find((x) => x.department === e.department).pieces += e.qty; }
  const byDay = r.days.map((ymd) => { const w = shift.istDayWindow(ymd); const l = all.filter((e) => e.at >= w.start && e.at < w.end); return { date: ymd, pieces: sum(l), departments: depts.map((d) => ({ department: d, pieces: sum(l.filter((e) => e.department === d)) })) }; });
  const log = all.sort((a, b) => a.at - b.at).slice(0, 2000).map((e) => { const w = snap.index.byId.get(e.woId); const h = w ? snap.headers.get(w.moId) : snap.headers.get(e.moId); return { at: e.at, department: e.department, label: DEPARTMENT_META[e.department].label, qty: e.qty, unit: e.unit, moNumber: h?.moNumber || "", poNumber: h?.poNumber || "", customerName: h?.customerName || "", number: w?.number || "", product: w?.product || "", variant: w?.variant || "", person: e.personName, source: e.source }; });
  return { ...r, scope: f, generatedAt: new Date(), totals: { pieces: sum(all), events: all.length, orders: new Set(all.map((e) => e.moId)).size, workOrders: new Set(all.map((e) => e.woId).filter(Boolean)).size, people: byPerson.length, firstAt: firstAt(all), lastAt: lastAt(all) }, departments: perDept, orders: byOrder, workOrders: byWo, variants: byVariant, people: byPerson, hours: byHour, days: byDay, log, logTruncated: all.length > 2000 };
}

/* ── target vs achievement ───────────────────────────────────────────────── */

async function achievement(companyId, q = {}) {
  const r = rangeOf({ ...q, fromAt: undefined, toAt: undefined });
  const f = scopeFilter(q);
  const snap = await orders.snapshot(companyId, { asOfDay: r.to });
  const stds = await standards.standardsFor(companyId);
  const targets = snap.targets.filter((t) => (!f.department || t.department === f.department) && (!f.moId || String(t.manufacturingOrderId) === f.moId) && t.from <= r.to && t.to >= r.from);
  const rows = [];
  for (const t of targets) {
    const moId = String(t.manufacturingOrderId);
    const h = snap.headers.get(moId);
    const l = snap.eventsByMo.get(moId)?.get(t.department) || [];
    const std = stds.get(t.department) || null;
    const e = ev.evaluateTarget(t, l, r.to, { doneOverall: sum(l), orderQuantity: t.orderQuantity, standard: std });
    const days = e.rows.filter((x) => x.date >= r.from && x.date <= r.to);
    const target = days.reduce((n, x) => n + x.expected, 0), actual = days.reduce((n, x) => n + x.done, 0);
    const daysLeft = e.span.daysLeft;
    rows.push({
      targetId: String(t._id), department: t.department, label: DEPARTMENT_META[t.department].label, moId, moNumber: t.moNumber, poNumber: h?.poNumber || "", customerName: t.customerName, kind: t.kind, pieces: t.pieces, from: t.from, to: t.to, hoursFrom: t.hoursFrom || "", hoursTo: t.hoursTo || "", workingDays: t.workingDays, description: ev.describeTarget(t), status: e.status, endStatus: t.status, assignedBy: t.assignedBy?.name || "", assignedAt: t.assignedAt,
      target, actual, difference: actual - target, achievementPct: target ? Math.round((actual / target) * 100) : null, remaining: e.span.remaining, expectedPace: e.perDay, requiredPace: e.span.neededPerDay, actualPace: e.span.avgPerActiveDay, daysLeft,
      projectedCompletion: e.span.remaining > 0 && e.span.avgPerActiveDay > 0 ? shift.shiftDayKey(r.to, Math.ceil(e.span.remaining / e.span.avgPerActiveDay)) : (e.span.remaining === 0 ? "met" : null),
      today: e.today, toDate: e.toDate, span: e.span, advice: e.advice, days, capacityPerDay: std?.capacity?.perDay ?? null, standard: std ? { samMinutesPerPiece: std.samMinutesPerPiece, operators: std.operators, hoursPerDay: std.hoursPerDay, efficiencyPct: std.efficiencyPct } : null,
      efficiency: std ? (() => { const earned = actual * std.samMinutesPerPiece; const avail = std.operators * (std.hoursPerDay || 8) * 60 * days.length; return { earnedMinutes: Math.round(earned), availableMinutes: Math.round(avail), pct: avail ? Math.round((earned / avail) * 100) : null }; })() : null,
      hours: e.today?.hours || null,
    });
  }
  rows.sort((a, b) => (a.status === "behind" ? 0 : 1) - (b.status === "behind" ? 0 : 1) || a.department.localeCompare(b.department));
  const agg = (keyOf, labelOf) => [...groupBy(rows, keyOf).entries()].map(([k, l]) => ({ key: k, label: labelOf(l[0]), targets: l.length, target: l.reduce((n, x) => n + x.target, 0), actual: l.reduce((n, x) => n + x.actual, 0), behind: l.filter((x) => x.status === "behind").length, achieved: l.filter((x) => x.status === "achieved" || x.status === "exceeded").length })).map((x) => ({ ...x, difference: x.actual - x.target, achievementPct: x.target ? Math.round((x.actual / x.target) * 100) : null }));
  const byDate = r.days.map((ymd) => { const d = rows.flatMap((x) => x.days.filter((y) => y.date === ymd)); const target = d.reduce((n, x) => n + x.expected, 0), actual = d.reduce((n, x) => n + x.done, 0); return { date: ymd, targets: d.length, target, actual, difference: actual - target, achievementPct: target ? Math.round((actual / target) * 100) : null }; });
  return { ...r, scope: f, totals: { targets: rows.length, target: rows.reduce((n, x) => n + x.target, 0), actual: rows.reduce((n, x) => n + x.actual, 0), behind: rows.filter((x) => x.status === "behind").length, onTrack: rows.filter((x) => x.status === "on_track").length, achieved: rows.filter((x) => x.status === "achieved" || x.status === "exceeded").length, notStarted: rows.filter((x) => x.status === "not_started").length }, byDepartment: agg((x) => x.department, (x) => x.label), byOrder: agg((x) => x.moId, (x) => `${x.moNumber} · ${x.customerName}`), byDate, targets: rows };
}

/* ── efficiency ──────────────────────────────────────────────────────────── */

async function efficiency(companyId, q = {}) {
  const r = rangeOf({ ...q, fromAt: undefined, toAt: undefined });
  const f = scopeFilter(q);
  const snap = await orders.snapshot(companyId, { asOfDay: r.to, start: r.start, end: r.end });
  const { events } = scoped(snap, f);
  const stds = await standards.standardsFor(companyId);
  const depts = (f.department ? [f.department] : DEPARTMENTS);
  const rows = depts.map((d) => {
    const std = stds.get(d) || null;
    const l = events.get(d) || [];
    const days = r.days.map((ymd) => { const w = shift.istDayWindow(ymd); const dl = l.filter((e) => e.at >= w.start && e.at < w.end); const pieces = sum(dl); const eff = std ? ev.efficiencyOf(pieces, { hoursFrom: "", hoursTo: "" }, ymd, std, new Date()) : null; return { date: ymd, pieces, earnedMinutes: eff?.earnedMinutes ?? null, availableMinutes: eff?.availableMinutes ?? null, efficiencyPct: eff?.pct ?? null, utilisationPct: std?.capacity?.perDay ? Math.round((pieces / std.capacity.perDay) * 100) : null, people: new Set(dl.map((e) => e.personName || e.personKey).filter(Boolean)).size }; });
    const active = days.filter((x) => x.pieces > 0);
    const pieces = sum(l), earned = std ? pieces * std.samMinutesPerPiece : null, available = std ? active.reduce((n, x) => n + (x.availableMinutes || 0), 0) : null;
    return { department: d, label: DEPARTMENT_META[d].label, hasStandard: Boolean(std), standard: std ? { samMinutesPerPiece: std.samMinutesPerPiece, operators: std.operators, hoursPerDay: std.hoursPerDay, plannedEfficiencyPct: std.efficiencyPct, capacityPerDay: std.capacity?.perDay ?? null, capacityPerHour: std.capacity?.perHour ?? null } : null, pieces, activeDays: active.length, earnedMinutes: earned != null ? Math.round(earned) : null, availableMinutes: available != null ? Math.round(available) : null, efficiencyPct: available ? Math.round((earned / available) * 100) : null, avgUtilisationPct: std?.capacity?.perDay && active.length ? Math.round((pieces / (std.capacity.perDay * active.length)) * 100) : null, plannedLoad: Math.round(r.days.reduce((n, ymd) => n + expectedDay(targetsOn(snap.targets, d, ymd)), 0)), days };
  });
  return { ...r, scope: f, departments: rows };
}

/* ── delay / shortfall ───────────────────────────────────────────────────── */

async function delays(companyId, q = {}) {
  const date = YMD.test(String(q.date || "")) ? q.date : todayKey();
  const snap = await orders.snapshot(companyId, { asOfDay: date });
  const rows = orders.summariseOrders(snap);
  const stds = await standards.standardsFor(companyId);
  const out = [];
  for (const r of rows) {
    if (r.productionStatus === "completed") continue;
    const ts = (snap.targetsByMo.get(r.moId) || []).filter((t) => t.status === "active");
    const deptRows = r.departments.filter((d) => d.applicable).map((d) => {
      const t = ts.find((x) => x.department === d.department) || null;
      const l = snap.eventsByMo.get(r.moId)?.get(d.department) || [];
      const e = t ? ev.evaluateTarget(t, l, date, { doneOverall: d.done, orderQuantity: r.quantity, standard: stds.get(d.department) || null }) : null;
      const daysToDelivery = r.daysToDelivery;
      return { department: d.department, label: d.label, planned: r.quantity, actual: d.done, shortfall: d.remaining, pct: d.pct, today: d.today, hasTarget: Boolean(t), targetStatus: e?.status || null, targetShort: e ? e.toDate.short : null, targetAdvice: e?.advice || "", requiredPerDayToTarget: e?.span?.neededPerDay ?? null, requiredPerDayToDelivery: daysToDelivery != null && daysToDelivery > 0 && d.remaining > 0 ? Math.ceil(d.remaining / daysToDelivery) : null, capacityPerDay: stds.get(d.department)?.capacity?.perDay ?? null, furthestBehind: false };
    });
    /* The stage furthest behind: the earliest applicable stage still short. */
    const behindStages = deptRows.filter((d) => d.shortfall > 0);
    const furthest = behindStages[0] || null;
    if (furthest) furthest.furthestBehind = true;
    const isDelayed = r.risk === "overdue" || r.risk === "at_risk" || r.targetStatus === "behind";
    if (!isDelayed && !q.all) continue;
    out.push({ moId: r.moId, moNumber: r.moNumber, poNumber: r.poNumber, customerName: r.customerName, orderType: r.orderType, deliveryDate: r.deliveryDate, daysToDelivery: r.daysToDelivery, risk: r.risk, estimatedCompletion: r.estimatedCompletion, quantity: r.quantity, produced: r.produced, remaining: r.remaining, progressPct: r.progressPct, currentStage: r.currentStage, currentStageLabel: r.currentStageLabel, targetStatus: r.targetStatus, targetsBehind: r.targetsBehind, recentPerDay: r.recentPerDay, requiredPerDay: r.requiredPerDay, furthestBehindStage: furthest ? furthest.department : null, furthestBehindLabel: furthest ? furthest.label : null, departments: deptRows, reasons: [r.risk === "overdue" ? "Delivery date has passed" : null, r.risk === "at_risk" ? "Projected completion is after the delivery date" : null, r.targetStatus === "behind" ? `${r.targetsBehind} target${r.targetsBehind === 1 ? "" : "s"} behind` : null].filter(Boolean) });
  }
  out.sort((a, b) => ({ overdue: 0, at_risk: 1, due_soon: 2, on_track: 3, none: 4 }[a.risk] - { overdue: 0, at_risk: 1, due_soon: 2, on_track: 3, none: 4 }[b.risk]) || (a.daysToDelivery ?? 9999) - (b.daysToDelivery ?? 9999));
  const byDept = DEPARTMENTS.map((d) => ({ department: d, label: DEPARTMENT_META[d].label, ordersFurthestBehind: out.filter((o) => o.furthestBehindStage === d).length, shortfall: out.reduce((n, o) => n + (o.departments.find((x) => x.department === d)?.shortfall || 0), 0), targetsBehind: out.reduce((n, o) => n + (o.departments.find((x) => x.department === d)?.targetStatus === "behind" ? 1 : 0), 0) }));
  return { date, totals: { delayed: out.length, overdue: out.filter((o) => o.risk === "overdue").length, atRisk: out.filter((o) => o.risk === "at_risk").length, behindTarget: out.filter((o) => o.targetStatus === "behind").length, shortfall: out.reduce((n, o) => n + o.remaining, 0) }, byDepartment: byDept, orders: out };
}

/* ── product / variant, across orders ────────────────────────────────────── */

async function productVariant(companyId, q = {}) {
  const r = q.from || q.to || q.date ? rangeOf({ ...q, fromAt: undefined, toAt: undefined }) : null;
  const f = scopeFilter(q);
  const snap = await orders.snapshot(companyId, r ? { asOfDay: r.to, start: r.start, end: r.end } : {});
  const { events } = scoped(snap, { product: f.product, variant: f.variant, customer: f.customer, orderType: f.orderType });
  const byWo = new Map();
  for (const [d, l] of events) for (const e of l) { if (!e.woId) continue; if (!byWo.has(e.woId)) byWo.set(e.woId, new Map()); const m = byWo.get(e.woId); if (!m.has(d)) m.set(d, []); m.get(d).push(e); }
  const wos = snap.index.list.filter((w) => woMatches(w, snap.headers.get(w.moId), { product: f.product, variant: f.variant, customer: f.customer, orderType: f.orderType }));
  const products = [...groupBy(wos, (w) => `${w.product}|${w.reference}`).entries()].map(([, list]) => {
    const first = list[0];
    const variants = [...groupBy(list, (w) => w.variant || "—").entries()].map(([variant, vl]) => {
      const qty = vl.filter((w) => w.status !== "cancelled").reduce((n, w) => n + w.quantity, 0);
      const deps = DEPARTMENTS.map((d) => ({ department: d, label: DEPARTMENT_META[d].label, done: vl.reduce((n, w) => n + ledger.unitsOf(byWo.get(w.id)?.get(d) || []), 0) }));
      const produced = deps.find((d) => d.department === "production").done;
      return { variant, size: vl[0].size, colour: vl[0].colour, quantity: qty, produced, remaining: Math.max(0, qty - produced), pct: pct(Math.min(produced, qty || produced), qty), orders: new Set(vl.map((w) => w.moId)).size, workOrders: vl.map((w) => ({ id: w.id, number: w.number, moId: w.moId, moNumber: snap.headers.get(w.moId)?.moNumber || "", customerName: snap.headers.get(w.moId)?.customerName || w.customerName, quantity: w.quantity, produced: ledger.unitsOf(byWo.get(w.id)?.get("production") || []) })), departments: deps };
    }).sort((a, b) => b.quantity - a.quantity);
    const qty = variants.reduce((n, v) => n + v.quantity, 0), produced = variants.reduce((n, v) => n + v.produced, 0);
    return { stockItemId: first.stockItemId, product: first.product, reference: first.reference, category: first.category, genderCategory: first.genderCategory, image: first.image, quantity: qty, produced, remaining: Math.max(0, qty - produced), pct: pct(Math.min(produced, qty || produced), qty), orders: new Set(list.map((w) => w.moId)).size, workOrders: list.length, variants, departments: DEPARTMENTS.map((d) => ({ department: d, label: DEPARTMENT_META[d].label, done: variants.reduce((n, v) => n + v.departments.find((x) => x.department === d).done, 0) })) };
  }).sort((a, b) => b.quantity - a.quantity);
  return { range: r, scope: f, totals: { products: products.length, variants: products.reduce((n, p) => n + p.variants.length, 0), quantity: products.reduce((n, p) => n + p.quantity, 0), produced: products.reduce((n, p) => n + p.produced, 0) }, products };
}

/* ── the report catalogue ────────────────────────────────────────────────── */

const REPORTS = Object.freeze({
  order: { label: "Order production report", explain: "One order: identity, products and variants, work orders, every department's progress, targets against actual, completion and delay.", filters: ["moId"] },
  workOrder: { label: "Work order report", explain: "One work order: its order and PO, product and variant, department progression, scan summary and completion.", filters: ["woId"] },
  department: { label: "Department production report", explain: "One department over a date range: pieces, targets, achievement, orders and work orders handled, product and variant breakdown, hour and day breakdown, efficiency.", filters: ["department", "from", "to"] },
  daily: { label: "Daily production report", explain: "One day: every department's pieces, targets and achievement, with order, work order, product and variant breakdown.", filters: ["date"] },
  hourly: { label: "Hourly production report", explain: "One day hour by hour, for a department (and optionally one order or work order).", filters: ["date", "department", "moId", "woId"] },
  range: { label: "Custom date-time range", explain: "Everything recorded between two moments, e.g. 10 Sep 09:30 to 14 Sep 14:00.", filters: ["fromAt", "toAt", "department", "moId", "woId"] },
  achievement: { label: "Target achievement report", explain: "Every target in the period: target, actual, difference, achievement, required and actual pace.", filters: ["from", "to", "department", "moId"] },
  efficiency: { label: "Efficiency report", explain: "Earned minutes against available minutes from IE's standards, per department and day.", filters: ["from", "to", "department", "product", "variant", "moId"] },
  delays: { label: "Delay / shortfall report", explain: "Orders behind their delivery date or their targets: planned, actual, shortfall and the recovery pace required.", filters: ["date"] },
  productVariant: { label: "Product / variant report", explain: "One product or variant across every order it appears on.", filters: ["product", "variant", "from", "to"] },
  personWise: { label: "Person-wise / MPC report", explain: "Every person on a measurement order: their units, each department's progress on them, and completion.", filters: ["moId"] },
});

async function report(companyId, type, q = {}) {
  switch (type) {
    case "order": { const d = await orders.orderDetail(companyId, q.moId, YMD.test(String(q.date || "")) ? q.date : todayKey()); return d ? { type, generatedAt: new Date(), filters: q, ...d } : null; }
    case "workOrder": { const d = await orders.workOrderDetail(companyId, q.woId); return d ? { type, generatedAt: new Date(), filters: q, ...d } : null; }
    case "department": { if (!DEPARTMENTS.includes(q.department)) return null; const [rg, ach, eff] = await Promise.all([range(companyId, { ...q, fromAt: undefined, toAt: undefined }), achievement(companyId, q), efficiency(companyId, q)]); return { type, generatedAt: new Date(), filters: q, department: q.department, label: DEPARTMENT_META[q.department].label, ...rg, achievement: ach, efficiency: eff.departments[0] || null }; }
    case "daily": { const d = await daily(companyId, { from: q.date, to: q.date }); const rg = await range(companyId, { from: q.date, to: q.date }); return { type, generatedAt: new Date(), filters: q, day: d.days[0] || null, ...rg }; }
    case "hourly": return { type, generatedAt: new Date(), filters: q, ...(await hourly(companyId, q)) };
    case "range": return { type, generatedAt: new Date(), filters: q, ...(await range(companyId, q)) };
    case "achievement": return { type, generatedAt: new Date(), filters: q, ...(await achievement(companyId, q)) };
    case "efficiency": return { type, generatedAt: new Date(), filters: q, ...(await efficiency(companyId, q)) };
    case "delays": return { type, generatedAt: new Date(), filters: q, ...(await delays(companyId, q)) };
    case "productVariant": return { type, generatedAt: new Date(), filters: q, ...(await productVariant(companyId, q)) };
    case "personWise": { const d = await orders.personWise(companyId, q.moId); return d ? { type, generatedAt: new Date(), filters: q, ...d } : null; }
    default: return null;
  }
}

module.exports = { REPORTS, rangeOf, scopeFilter, targetsOn, expectedDay, expectedInBucket, hourly, daily, departmentPage, range, achievement, efficiency, delays, productVariant, report };
