// services/ppc/control/targetBoard.service.js
//
// TARGETS, IN PLAIN WORDS (27 Sep 2026).
//
// Two reads every target screen is built on, so each shows the same figures:
//
//   list(companyId, q)  every target — which order, which department, when it
//                       starts and ends, how much was asked, how much is done,
//                       how much is left, and one plain state:
//                         upcoming   starts later
//                         on_track   running, keeping pace
//                         behind     running, short of the pace
//                         done       everything asked is done
//                         missed     ended short
//                         stopped    replaced or cancelled
//   day(companyId, q)   one day for PPC: the targets running that day, by
//                       department, what each asked that day and what was
//                       done; what starts soon, what ends soon, what just
//                       ended; active orders with no target; deliveries due.
//
// Both read the shared company snapshot (orders.service), evaluate each target
// with the same arithmetic as the order page (orderTargets.evaluate.js) and
// read "done" from the same ledger the pipeline shows. Nothing is typed in.
"use strict";

const orders = require("./orders.service");
const { DEPARTMENT_META, DEPARTMENTS } = require("./ledger.service");
const ev = require("../orderTargets.evaluate");

const STATE_WORD = Object.freeze({
  upcoming: "Starts later", on_track: "On track", behind: "Behind", done: "Done", missed: "Missed", stopped: "Stopped",
});

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fmt = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** One target, evaluated and put into words. */
function describe(t, row, events, asOfDay) {
  const e = ev.evaluateTarget(t, events, asOfDay, { orderQuantity: row?.quantity, doneOverall: row?.departments.find((d) => d.department === t.department)?.done ?? null });
  const asked = e.totalExpected;
  const done = e.span.done;
  const left = Math.max(0, asked - done);
  let state;
  if (t.status !== "active") state = "stopped";
  else if (!e.started) state = "upcoming";
  else if (done >= asked && asked > 0) state = "done";
  else if (e.over) state = "missed";
  else state = e.status === "behind" ? "behind" : "on_track";
  const startsIn = !e.started ? daysBetween(asOfDay, t.from) : 0;
  const endsIn = e.over ? null : daysBetween(asOfDay, t.to);
  /* one sentence a person on the floor can read */
  let say;
  if (state === "stopped") say = t.status === "replaced" ? "Replaced by a newer target." : `Cancelled${t.endReason ? ` — ${t.endReason}` : ""}.`;
  else if (state === "upcoming") say = `Starts ${startsIn === 1 ? "tomorrow" : `in ${startsIn} days`} (${fmt(t.from)}). ${e.perDay} a day until ${fmt(t.to)}.`;
  else if (state === "done") say = `Finished: ${done} of ${asked} done.`;
  else if (state === "missed") say = `Ended ${fmt(t.to)} with ${left} not done (${done} of ${asked}).`;
  else if (e.covers && e.today) say = `Today: ${e.today.done} of ${e.today.expected} done. ${left} left in total, ${endsIn === 0 ? "last day today" : `${endsIn} day${endsIn === 1 ? "" : "s"} to go`}.`;
  else say = `${left} left, ${endsIn === 0 ? "last day today" : `${endsIn} day${endsIn === 1 ? "" : "s"} to go`}.`;
  const delivery = row?.deliveryDate ? ev.dayOf(row.deliveryDate) : null;
  return {
    targetId: String(t._id), status: t.status, state, stateWord: STATE_WORD[state], say,
    moId: String(t.manufacturingOrderId), moNumber: t.moNumber || row?.moNumber || "", customerName: t.customerName || row?.customerName || "",
    department: t.department, label: DEPARTMENT_META[t.department]?.label || t.department,
    kind: t.kind, description: ev.describeTarget(t), hoursFrom: t.hoursFrom || "", hoursTo: t.hoursTo || "",
    from: t.from, to: t.to, days: e.days, perDay: e.perDay,
    asked, done, left, pct: asked ? Math.min(100, Math.round((done / asked) * 100)) : 0,
    today: e.covers && e.today ? { expected: e.today.expected, done: e.today.done, short: e.today.short } : null,
    running: e.covers, startsIn, endsIn, daysLeft: e.span.daysLeft, neededPerDay: e.span.neededPerDay,
    orderQuantity: row?.quantity ?? t.orderQuantity ?? 0,
    orderDone: row?.departments.find((d) => d.department === t.department)?.done ?? null,
    deliveryDate: delivery, endsAfterDelivery: Boolean(delivery && t.to > delivery),
    assignedBy: t.assignedBy?.name || "", assignedAt: t.assignedAt || null,
    endedAt: t.endedAt || null, endReason: t.endReason || "",
  };
}

async function evaluated(companyId, asOfDay) {
  const snap = await orders.snapshot(companyId, { asOfDay });
  const rows = orders.summariseOrders(snap);
  const rowByMo = new Map(rows.map((r) => [r.moId, r]));
  const items = (snap.targets || []).map((t) => {
    const mo = String(t.manufacturingOrderId);
    const events = snap.eventsByMo.get(mo)?.get(t.department) || [];
    return describe(t, rowByMo.get(mo), events, asOfDay);
  });
  return { rows, rowByMo, items };
}

const ORDER = { behind: 0, on_track: 1, upcoming: 2, missed: 3, done: 4, stopped: 5 };
const countBy = (xs) => xs.reduce((m, x) => ((m[x.state] = (m[x.state] || 0) + 1), m), {});

/** Every target, newest first within each state. `?state=`, `?department=`, `?moId=`, `?q=`. */
async function list(companyId, q = {}) {
  const asOfDay = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || "")) ? q.date : orders.todayKey();
  const { items } = await evaluated(companyId, asOfDay);
  let out = items;
  if (!q.includeStopped || q.includeStopped === "0") out = out.filter((x) => x.state !== "stopped" || q.state === "stopped");
  if (q.state) out = out.filter((x) => x.state === q.state || (q.state === "running" && (x.state === "on_track" || x.state === "behind")));
  if (q.department) out = out.filter((x) => x.department === q.department);
  if (q.moId) out = out.filter((x) => x.moId === String(q.moId));
  if (q.q) { const n = String(q.q).toLowerCase(); out = out.filter((x) => [x.moNumber, x.customerName, x.label, x.description].some((v) => String(v || "").toLowerCase().includes(n))); }
  out = out.slice().sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || a.to.localeCompare(b.to) || a.moNumber.localeCompare(b.moNumber));
  const live = items.filter((x) => x.state !== "stopped");
  return { asOfDay, counts: { all: live.length, ...countBy(live), stopped: items.length - live.length }, targets: out };
}

/** One day, for PPC. */
async function day(companyId, q = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || "")) ? q.date : orders.todayKey();
  const today = orders.todayKey();
  const { rows, items: raw } = await evaluated(companyId, date);
  /* A future day has not happened: which targets run on it and what they ask
     come from that day, but how each target STANDS is today's — otherwise
     every target looks "behind" on a day nobody has worked yet. */
  let items = raw;
  if (date > today) {
    const now = new Map((await evaluated(companyId, today)).items.map((x) => [x.targetId, x]));
    items = raw.map((x) => { const t = now.get(x.targetId); return t ? { ...x, state: t.state === "upcoming" ? "upcoming" : t.state, stateWord: t.state === "upcoming" ? "Planned" : t.stateWord, done: t.done, left: t.left, pct: t.pct, say: x.running ? `Planned: ${x.today?.expected ?? x.perDay} asked this day. So far ${t.done} of ${t.asked} done.` : t.say } : x; });
  }
  const live = items.filter((x) => x.state !== "stopped");
  const running = live.filter((x) => x.running);
  const startingSoon = live.filter((x) => x.state === "upcoming" && x.startsIn <= 7).sort((a, b) => a.from.localeCompare(b.from));
  const endingSoon = live.filter((x) => (x.state === "on_track" || x.state === "behind") && x.endsIn != null && x.endsIn <= 2).sort((a, b) => a.to.localeCompare(b.to));
  const justEnded = live.filter((x) => (x.state === "done" || x.state === "missed") && daysBetween(x.to, date) <= 3 && x.to <= date).sort((a, b) => b.to.localeCompare(a.to));

  const departments = DEPARTMENTS.map((d) => {
    const ts = running.filter((x) => x.department === d);
    const asked = ts.reduce((n, x) => n + (x.today?.expected || 0), 0);
    const done = ts.reduce((n, x) => n + (x.today?.done || 0), 0);
    return {
      department: d, label: DEPARTMENT_META[d].label, targets: ts.length, orders: new Set(ts.map((x) => x.moId)).size,
      asked, done, left: Math.max(0, asked - done), pct: asked ? Math.round((done / asked) * 100) : null,
      behind: ts.filter((x) => x.state === "behind").length,
      upcoming: startingSoon.filter((x) => x.department === d).length,
    };
  });

  const activeOrders = rows.filter((r) => r.productionStatus !== "completed");
  const targeted = new Set(live.filter((x) => x.state !== "done" && x.state !== "missed").map((x) => x.moId));
  const noTarget = activeOrders.filter((r) => !targeted.has(r.moId)).map((r) => ({
    moId: r.moId, moNumber: r.moNumber, customerName: r.customerName, quantity: r.quantity, produced: r.produced, remaining: r.remaining,
    deliveryDate: r.deliveryDate ? ev.dayOf(r.deliveryDate) : null, daysToDelivery: r.daysToDelivery ?? null, risk: r.risk,
  })).sort((a, b) => (a.deliveryDate || "9999").localeCompare(b.deliveryDate || "9999"));
  const deliveries = activeOrders.filter((r) => r.deliveryDate && ev.dayOf(r.deliveryDate) <= ev.shiftDay(date, 7)).map((r) => ({
    moId: r.moId, moNumber: r.moNumber, customerName: r.customerName, deliveryDate: ev.dayOf(r.deliveryDate), quantity: r.quantity, produced: r.produced, remaining: r.remaining, risk: r.risk,
    late: ev.dayOf(r.deliveryDate) < date,
  })).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));

  const asked = departments.reduce((n, d) => n + d.asked, 0);
  const done = departments.reduce((n, d) => n + d.done, 0);
  return {
    date, isToday: date === today, isPast: date < today, isFuture: date > today, generatedAt: new Date(),
    summary: {
      running: running.length, asked, done, left: Math.max(0, asked - done), pct: asked ? Math.round((done / asked) * 100) : null,
      behind: running.filter((x) => x.state === "behind").length, onTrack: running.filter((x) => x.state === "on_track").length,
      doneToday: running.filter((x) => x.today && x.today.done >= x.today.expected && x.today.expected > 0).length,
      startingSoon: startingSoon.length, endingSoon: endingSoon.length, justEnded: justEnded.length,
      activeOrders: activeOrders.length, ordersWithoutTarget: noTarget.length,
      deliveries: deliveries.length, lateDeliveries: deliveries.filter((x) => x.late).length,
    },
    departments, running: running.sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || DEPARTMENT_META[a.department].order - DEPARTMENT_META[b.department].order),
    startingSoon, endingSoon, justEnded, noTarget, deliveries,
    orders: activeOrders.map((r) => ({ moId: r.moId, moNumber: r.moNumber, customerName: r.customerName, quantity: r.quantity, remaining: r.remaining, deliveryDate: r.deliveryDate })).sort((a, b) => a.moNumber.localeCompare(b.moNumber)),
  };
}

module.exports = { list, day, describe, STATE_WORD };
