// services/ppc/control/overview.service.js
//
// THE CONTROL CENTER'S LANDING FIGURES — the questions a production manager
// asks first thing: how many orders are active, planned, in production,
// delayed, ahead, done; how much is ordered, made and left; what today's
// targets ask for and what the floor has given; which departments are
// behind; which orders are at risk, waiting on a department, or close to
// their delivery date. Then today's snapshot, department by department.
//
// Every figure comes from orders.service (the order list) and
// reports.service (the hour-wise read), so the landing page and the pages it
// links to cannot disagree.
"use strict";

const orders = require("./orders.service");
const reports = require("./reports.service");
const { DEPARTMENTS, DEPARTMENT_META } = require("./ledger.service");

async function overview(companyId, q = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || "")) ? q.date : orders.todayKey();
  const [snap, hour] = await Promise.all([orders.snapshot(companyId, { asOfDay: date }), reports.hourly(companyId, { date })]);
  const rows = orders.summariseOrders(snap);

  const active = rows.filter((r) => r.productionStatus !== "completed");
  const delayed = rows.filter((r) => r.risk === "overdue" || r.risk === "at_risk");
  /* Waiting on a department: the furthest stage has finished the whole order
     and the stage AFTER it (in production order) has not recorded a piece.
     An earlier stage that was never recorded (cutting done off the desktop,
     say) is not "waiting" — the work has already moved past it. */
  const awaiting = active.map((r) => {
    const cur = r.currentStage ? r.departments.find((d) => d.department === r.currentStage) : null;
    if (!cur || cur.remaining !== 0) return null;
    const later = r.departments.filter((d) => d.applicable && DEPARTMENT_META[d.department].order > DEPARTMENT_META[cur.department].order);
    const next = later.find((d) => d.done < r.quantity);
    return next && next.done === 0 ? { ...r, waitingFor: next.department, waitingForLabel: DEPARTMENT_META[next.department].label } : null;
  }).filter(Boolean);
  const kpis = {
    orders: rows.length, active: active.length, notStarted: rows.filter((r) => r.productionStatus === "not_started").length, inProduction: rows.filter((r) => r.productionStatus === "in_production").length, completed: rows.filter((r) => r.productionStatus === "completed").length,
    planned: rows.filter((r) => r.workOrders > 0 && r.planning.workOrdersNotPlanned === 0).length, unplanned: rows.filter((r) => r.planning.workOrdersNotPlanned > 0).length,
    delayed: delayed.length, overdue: rows.filter((r) => r.risk === "overdue").length, atRisk: rows.filter((r) => r.risk === "at_risk").length, dueSoon: rows.filter((r) => r.risk === "due_soon").length,
    withTargets: rows.filter((r) => r.targets > 0).length, behindTarget: rows.filter((r) => r.targetStatus === "behind").length, aheadOfTarget: rows.filter((r) => r.targetStatus === "achieved").length, onTrack: rows.filter((r) => r.targetStatus === "on_track").length,
    awaitingDepartment: awaiting.length, bulk: rows.filter((r) => r.orderType === "bulk").length, personWise: rows.filter((r) => r.orderType === "person_wise").length,
    quantity: rows.reduce((n, r) => n + r.quantity, 0), produced: rows.reduce((n, r) => n + r.produced, 0), remaining: rows.reduce((n, r) => n + r.remaining, 0), packed: rows.reduce((n, r) => n + r.packed, 0), dispatched: rows.reduce((n, r) => n + r.dispatched, 0), qcPassed: rows.reduce((n, r) => n + r.qcPassed, 0), cut: rows.reduce((n, r) => n + r.cut, 0),
    workOrders: snap.index.list.filter((w) => w.status !== "cancelled").length,
  };
  const depts = hour.departments.map((d) => {
    const involved = active.filter((r) => r.currentStage === d.department || r.nextStage === d.department || r.departments.find((x) => x.department === d.department).today > 0);
    const behindHere = active.filter((r) => (snap.targetsByMo.get(r.moId) || []).some((t) => t.status === "active" && t.department === d.department) && r.targetStatus === "behind" && (r.departments.find((x) => x.department === d.department)?.hasTarget));
    const t = d.totals;
    const status = !d.hasTarget ? "no_target" : t.achievementPct == null ? "no_target" : t.actual >= t.target ? "achieved" : (() => { const soFar = d.hours.filter((h) => !h.future).reduce((n, h) => n + h.target, 0); return soFar === 0 ? "not_started" : t.actual >= soFar * 0.85 ? "on_track" : "behind"; })();
    return { department: d.department, label: d.label, hasTarget: d.hasTarget, target: t.target, actual: t.actual, achievementPct: t.achievementPct, remaining: t.remaining, pacePerHour: t.pacePerHour, expectedEndOfDay: t.expectedEndOfDay, requiredPerRemainingHour: t.requiredPerRemainingHour, efficiency: t.efficiency, capacityPerDay: t.capacityPerDay, status, activeOrders: involved.length, delayedOrders: involved.filter((r) => r.risk === "overdue" || r.risk === "at_risk").length + 0, behindTargetOrders: behindHere.length, orders: d.orders.slice(0, 5), people: t.people };
  });
  const todayTarget = depts.reduce((n, d) => n + d.target, 0), todayActual = depts.reduce((n, d) => n + d.actual, 0);
  const production = depts.find((d) => d.department === "production");
  const brief = (r) => ({ moId: r.moId, moNumber: r.moNumber, poNumber: r.poNumber, customerName: r.customerName, orderType: r.orderType, quantity: r.quantity, produced: r.produced, remaining: r.remaining, progressPct: r.progressPct, deliveryDate: r.deliveryDate, daysToDelivery: r.daysToDelivery, risk: r.risk, currentStage: r.currentStage, currentStageLabel: r.currentStageLabel, nextStage: r.nextStage, nextStageLabel: r.nextStageLabel, targetStatus: r.targetStatus, estimatedCompletion: r.estimatedCompletion, requiredPerDay: r.requiredPerDay, todayPieces: r.todayPieces });
  return {
    date, isToday: date === orders.todayKey(), generatedAt: new Date(), shift: hour.shift,
    kpis: { ...kpis, todayTarget, todayActual, todayAchievementPct: todayTarget ? Math.round((todayActual / todayTarget) * 100) : null, todayProduced: production?.actual || 0, todayProducedTarget: production?.target || 0, departmentsBehind: depts.filter((d) => d.status === "behind").length, departmentsAhead: depts.filter((d) => d.status === "achieved").length, departmentsWithTarget: depts.filter((d) => d.hasTarget).length },
    departments: depts,
    atRisk: delayed.slice(0, 10).map(brief), awaiting: awaiting.slice(0, 10).map((r) => ({ ...brief(r), waitingFor: r.waitingFor, waitingForLabel: r.waitingForLabel })), approaching: rows.filter((r) => r.risk === "due_soon").slice(0, 10).map(brief),
    behindTarget: rows.filter((r) => r.targetStatus === "behind").slice(0, 10).map(brief), aheadOfTarget: rows.filter((r) => r.targetStatus === "achieved").slice(0, 10).map(brief),
    recent: rows.filter((r) => r.lastActivityAt).sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt)).slice(0, 8).map((r) => ({ ...brief(r), lastActivityAt: r.lastActivityAt, lastActivityDepartment: r.lastActivityDepartment, lastActivityLabel: r.lastActivityDepartment ? DEPARTMENT_META[r.lastActivityDepartment].label : "" })),
    pipeline: DEPARTMENTS.map((d) => ({ department: d, label: DEPARTMENT_META[d].label, done: rows.reduce((n, r) => n + (r.departments.find((x) => x.department === d)?.done || 0), 0), today: rows.reduce((n, r) => n + (r.departments.find((x) => x.department === d)?.today || 0), 0), ordersHere: active.filter((r) => r.currentStage === d).length, ordersNext: active.filter((r) => r.nextStage === d).length })),
  };
}

module.exports = { overview };
