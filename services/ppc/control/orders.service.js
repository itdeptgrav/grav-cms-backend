// services/ppc/control/orders.service.js
//
// THE ORDER, AS PPC SEES IT — one normalised shape for every screen.
//
// There is no ManufacturingOrder collection: a manufacturing order IS a
// CustomerRequest that Sales approved, and its number is `MO-<requestId>`.
// The PO number lives on the current quotation's `poProof`, the delivery date
// on `customerInfo.deliveryDeadline`, the people (for a person-wise order) on
// each item variant's `persons[]` and on EmployeeProductionProgress. Every
// screen that guessed a different path showed "—"; this file resolves each of
// them ONCE, server-side, and every PPC page reads the result.
//
// Quantities and progress come from ledger.service.js — the departments' own
// books — never from a typed number.
"use strict";

const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const EmployeeProductionProgress = require("../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const PpcOrderTarget = require("../../../models/CMS_Models/PPC/PpcOrderTarget");
const ledger = require("./ledger.service");
const ev = require("../orderTargets.evaluate");
const shift = require("../../manufacturing/shiftHours");
const standards = require("../../industrialEngineering/departmentStandards.service");

const { DEPARTMENTS, DEPARTMENT_META, FINISHING, isId, oid, sum, lastAt, firstAt, groupBy } = ledger;
const DAY_MS = 86400000;
const todayKey = () => shift.istDayWindow().label;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/* ── the order header ────────────────────────────────────────────────────── */

const MO_SELECT = "requestId customerId customerInfo.name customerInfo.email customerInfo.phone customerInfo.deliveryDeadline requestType measurementId measurementName status priority createdAt updatedAt estimatedCompletion actualCompletion items quotations.poProof quotations.salesApproval quotations.status quotations.quotationNumber quotations.date orderOrigin fulfilmentModel isInternalOrder";

/** PO from wherever Sales put it: the current quotation first, then any revision. */
function poOf(mo) {
  const qs = [...(mo.quotations || [])];
  const withPo = qs.find((q) => q?.poProof?.poNumber) || null;
  const q = withPo || qs[0] || null;
  return {
    poNumber: withPo?.poProof?.poNumber || "", poDate: withPo?.poProof?.poDate || null, poValue: withPo?.poProof?.poValue ?? null,
    quotationNumber: q?.quotationNumber || "", salesApprovedAt: q?.salesApproval?.approvedAt || null,
  };
}

function orderTypeOf(mo) {
  return mo.requestType === "measurement_conversion" || Boolean(mo.measurementId) ? "person_wise" : "bulk";
}

function headerOf(mo) {
  const po = poOf(mo);
  const itemsQuantity = (mo.items || []).reduce((n, i) => n + (Number(i.totalQuantity) || (i.variants || []).reduce((m, v) => m + (Number(v.quantity) || 0), 0)), 0);
  const persons = new Set();
  for (const i of mo.items || []) for (const v of i.variants || []) for (const p of v.persons || []) persons.add(String(p.employeeUIN || p.employeeId || p.employeeName || ""));
  return {
    moId: String(mo._id), moNumber: mo.requestId ? `MO-${mo.requestId}` : "", requestId: mo.requestId || "",
    ...po,
    customerId: mo.customerId ? String(mo.customerId) : "", customerName: mo.customerInfo?.name || "", customerEmail: mo.customerInfo?.email || "",
    orderDate: mo.createdAt || null, deliveryDate: mo.customerInfo?.deliveryDeadline || mo.estimatedCompletion || null,
    deliveryDateSource: mo.customerInfo?.deliveryDeadline ? "customer" : (mo.estimatedCompletion ? "estimate" : ""),
    priority: mo.priority || "medium", status: mo.status || "", orderType: orderTypeOf(mo), measurementName: mo.measurementName || "",
    orderOrigin: mo.orderOrigin || "", fulfilmentModel: mo.fulfilmentModel || "", isInternalOrder: Boolean(mo.isInternalOrder),
    itemsQuantity, persons: persons.size,
    items: (mo.items || []).map((i) => ({
      lineRef: i.lineRef || "", stockItemId: i.stockItemId ? String(i.stockItemId) : "", product: i.stockItemName || "", reference: i.stockItemReference || "",
      totalQuantity: Number(i.totalQuantity) || 0,
      variants: (i.variants || []).map((v) => ({ variantId: v.variantId || "", attributes: (v.attributes || []).map((a) => ({ name: a?.name || "", value: a?.value == null ? "" : String(a.value) })), variant: ledger.variantOf(v.attributes), quantity: Number(v.quantity) || 0, persons: (v.persons || []).length })),
    })),
  };
}

async function headersFor(moIds) {
  const ids = [...new Set(moIds.filter(isId))];
  if (!ids.length) return new Map();
  const rows = await CustomerRequest.find({ _id: { $in: ids.map(oid) } }).select(MO_SELECT).lean();
  return new Map(rows.map((m) => [String(m._id), headerOf(m)]));
}

/* ── progress arithmetic ─────────────────────────────────────────────────── */

/** A finishing stage counts for an order only if the order used it. */
function applicable(department, doneEvents, targets) {
  if (!FINISHING.has(department)) return true;
  return doneEvents.length > 0 || targets.some((t) => t.department === department);
}

/**
 * The pipeline for a set of work orders: per department, done / remaining /
 * pct / first / last / today, against `quantity`.
 */
function pipelineOf(quantity, eventsByDept, targets = [], asOfDay = todayKey()) {
  const day = shift.istDayWindow(asOfDay);
  const out = [];
  for (const d of DEPARTMENTS) {
    const events = eventsByDept.get(d) || [];
    const done = ledger.unitsOf(events);
    const today = sum(events.filter((e) => e.at >= day.start && e.at < day.end));
    const used = applicable(d, events, targets);
    const activeTarget = targets.find((t) => t.department === d && t.status === "active") || null;
    out.push({
      department: d, label: DEPARTMENT_META[d].label, doneWord: DEPARTMENT_META[d].done, order: DEPARTMENT_META[d].order,
      applicable: used, quantity, done, remaining: Math.max(0, quantity - done), pct: pct(Math.min(done, quantity || done), quantity),
      overDone: Math.max(0, done - quantity), today, firstAt: firstAt(events), lastAt: lastAt(events),
      target: activeTarget ? { targetId: String(activeTarget._id), kind: activeTarget.kind, pieces: activeTarget.pieces, from: activeTarget.from, to: activeTarget.to, description: ev.describeTarget(activeTarget) } : null,
      targetCount: targets.filter((t) => t.department === d).length,
    });
  }
  return out;
}

/** Where the order is: the furthest department with activity, and the first
    applicable one still short of the quantity. */
function stageOf(pipeline, quantity) {
  const active = pipeline.filter((p) => p.applicable);
  const withWork = active.filter((p) => p.done > 0);
  const current = withWork.length ? withWork[withWork.length - 1] : null;
  const next = active.find((p) => p.done < quantity) || null;
  const complete = quantity > 0 && active.length > 0 && active.every((p) => p.done >= quantity);
  const started = withWork.length > 0;
  return {
    currentStage: current ? current.department : null, currentStageLabel: current ? current.label : "Not started",
    nextStage: next ? next.department : null, nextStageLabel: next ? next.label : (complete ? "Complete" : "—"),
    productionStatus: complete ? "completed" : started ? "in_production" : "not_started",
  };
}

/** Delivery risk against today, and a projection from the recent pace. */
function riskOf(header, produced, quantity, productionEvents, asOfDay = todayKey()) {
  const day = shift.istDayWindow(asOfDay);
  const remaining = Math.max(0, quantity - produced);
  const deliver = header.deliveryDate ? new Date(header.deliveryDate) : null;
  const daysToDelivery = deliver ? Math.ceil((deliver.getTime() - day.start.getTime()) / DAY_MS) : null;
  /* Pace: the last 14 days with any production. */
  const since = new Date(day.end.getTime() - 14 * DAY_MS);
  const recent = productionEvents.filter((e) => e.at >= since);
  const activeDays = new Set(recent.map((e) => shift.istDayKeyOf(e.at))).size;
  const perDay = activeDays ? sum(recent) / activeDays : 0;
  const daysNeeded = perDay > 0 ? Math.ceil(remaining / perDay) : null;
  const estimatedCompletion = remaining === 0 ? null : daysNeeded != null ? new Date(day.start.getTime() + daysNeeded * DAY_MS) : null;
  let risk = "none";
  if (quantity > 0 && remaining === 0) risk = "closed";
  else if (deliver && daysToDelivery < 0) risk = "overdue";
  else if (deliver && estimatedCompletion && estimatedCompletion > deliver) risk = "at_risk";
  else if (deliver && daysToDelivery <= 7) risk = "due_soon";
  else if (deliver) risk = "on_track";
  const requiredPerDay = deliver && daysToDelivery > 0 && remaining > 0 ? Math.ceil(remaining / daysToDelivery) : null;
  return { risk, daysToDelivery, recentPerDay: Math.round(perDay * 10) / 10, activeDays, estimatedCompletion, requiredPerDay };
}

/** Today's standing of every active target on this order, in one word. */
function targetStanding(targets, eventsByDept, quantity, asOfDay = todayKey()) {
  const active = targets.filter((t) => t.status === "active");
  if (!active.length) return { count: 0, status: "none", behind: 0, onTrack: 0, achieved: 0, departments: [] };
  const rows = active.map((t) => {
    const events = eventsByDept.get(t.department) || [];
    const r = ev.evaluateTarget(t, events, asOfDay, { doneOverall: sum(events), orderQuantity: quantity });
    return { department: t.department, status: r.status, today: r.today, covers: r.covers };
  });
  const behind = rows.filter((r) => r.status === "behind").length;
  const achieved = rows.filter((r) => r.status === "achieved" || r.status === "exceeded").length;
  const onTrack = rows.filter((r) => r.status === "on_track").length;
  const status = behind ? "behind" : onTrack ? "on_track" : achieved ? "achieved" : "not_started";
  return { count: active.length, status, behind, onTrack, achieved, departments: rows };
}

/* ── lists ───────────────────────────────────────────────────────────────── */

/**
 * Every production order of the company (an order with at least one work
 * order), summarised. Filters are applied here, server-side.
 */
/**
 * One read of the whole company: its work orders, order headers, every
 * department's events (all time, or `[start,end)`) and its targets. The
 * overview, the department pages and the reports all start here so they
 * cannot disagree with the order list.
 */
async function snapshot(companyId, { asOfDay = todayKey(), moIds = null, start = null, end = null } = {}) {
  const index = await ledger.woIndex(companyId, moIds ? { moIds } : {});
  const ids = [...index.byMo.keys()];
  const [headers, events, targets] = ids.length ? await Promise.all([
    headersFor(ids), ledger.readEvents(index, { start, end }), PpcOrderTarget.find({ companyId, manufacturingOrderId: { $in: ids.map(oid) } }).lean(),
  ]) : [new Map(), new Map(), []];
  const eventsByMo = new Map();
  for (const [d, list] of events) for (const e of list) { const k = e.moId; if (!k) continue; if (!eventsByMo.has(k)) eventsByMo.set(k, new Map()); const m = eventsByMo.get(k); if (!m.has(d)) m.set(d, []); m.get(d).push(e); }
  return { companyId: String(companyId), asOfDay, index, headers, events, eventsByMo, targets, targetsByMo: groupBy(targets, (t) => String(t.manufacturingOrderId)) };
}

async function listOrders(companyId, filters = {}) {
  const asOfDay = filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date) ? filters.date : todayKey();
  const snap = await snapshot(companyId, { asOfDay });
  let rows = summariseOrders(snap);
  const { index } = snap;
  if (!rows.length) return { rows: [], total: 0, asOfDay, facets: {} };
  const facets = {
    customers: [...new Set(rows.map((r) => r.customerName).filter(Boolean))].sort(),
    products: [...new Set(index.list.map((w) => w.product).filter(Boolean))].sort(),
    stages: [...new Set(rows.map((r) => r.currentStage).filter(Boolean))],
  };
  rows = applyFilters(rows, index, filters);
  rows.sort((a, b) => {
    const rank = { overdue: 0, at_risk: 1, due_soon: 2, on_track: 3, none: 4, closed: 5 };
    return (rank[a.risk] - rank[b.risk]) || (new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)) || (new Date(b.orderDate) - new Date(a.orderDate));
  });
  const total = rows.length;
  const page = Math.max(1, Number(filters.page) || 1), limit = Math.min(500, Math.max(1, Number(filters.limit) || 50));
  return { rows: rows.slice((page - 1) * limit, page * limit), total, page, limit, asOfDay, facets };
}

/** Every order in a snapshot, summarised (unfiltered, unsorted). */
function summariseOrders(snap) {
  const { index, headers, eventsByMo, targetsByMo: byMoTargets, asOfDay } = snap;
  const evByMo = eventsByMo;
  const moIds = [...index.byMo.keys()];
  const rows = [];
  for (const moId of moIds) {
    const h = headers.get(moId); if (!h) continue;
    const wos = index.byMo.get(moId) || [];
    const live = wos.filter((w) => w.status !== "cancelled");
    const quantity = live.reduce((n, w) => n + w.quantity, 0) || h.itemsQuantity;
    const byDept = evByMo.get(moId) || new Map();
    const ts = byMoTargets.get(moId) || [];
    const pipeline = pipelineOf(quantity, byDept, ts, asOfDay);
    const stage = stageOf(pipeline, quantity);
    const produced = pipeline.find((p) => p.department === "production").done;
    const risk = riskOf(h, produced, quantity, byDept.get("production") || [], asOfDay);
    const standing = targetStanding(ts, byDept, quantity, asOfDay);
    const day = shift.istDayWindow(asOfDay);
    const todayAll = [...byDept.values()].flat().filter((e) => e.at >= day.start && e.at < day.end);
    rows.push({
      ...h, quantity, workOrders: live.length, cancelledWorkOrders: wos.length - live.length,
      products: new Set(live.map((w) => `${w.product}|${w.reference}`)).size, variants: new Set(live.map((w) => `${w.product}|${w.reference}|${w.variant}`)).size,
      produced, remaining: Math.max(0, quantity - produced), progressPct: pct(Math.min(produced, quantity || produced), quantity),
      packed: pipeline.find((p) => p.department === "packaging").done, dispatched: pipeline.find((p) => p.department === "dispatch").done, qcPassed: pipeline.find((p) => p.department === "qc").done, cut: pipeline.find((p) => p.department === "cutting").done,
      ...stage, ...risk, targetStatus: standing.status, targets: standing.count, targetsBehind: standing.behind,
      todayPieces: sum(todayAll), lastActivityAt: lastAt([...byDept.values()].flat()), lastActivityDepartment: (() => { let best = null; for (const p of pipeline) if (p.lastAt && (!best || p.lastAt > best.lastAt)) best = p; return best ? best.department : null; })(),
      departments: pipeline.map((p) => ({ department: p.department, label: p.label, applicable: p.applicable, done: p.done, remaining: p.remaining, pct: p.pct, today: p.today, hasTarget: Boolean(p.target) })),
      planning: { workOrdersPlanned: live.filter((w) => ["complete", "released"].includes(w.planningState)).length, workOrdersNotPlanned: live.filter((w) => !["complete", "released"].includes(w.planningState)).length },
    });
  }
  return rows;
}

function applyFilters(rows, index, f) {
  const q = String(f.q || f.search || "").trim().toLowerCase();
  let out = rows;
  if (q) {
    out = out.filter((r) => {
      const wos = index.byMo.get(r.moId) || [];
      return [r.moNumber, r.requestId, r.poNumber, r.customerName, r.measurementName].some((s) => String(s || "").toLowerCase().includes(q))
        || wos.some((w) => [w.number, w.shortId, w.product, w.reference, w.variant].some((s) => String(s || "").toLowerCase().includes(q)));
    });
  }
  if (f.customer) out = out.filter((r) => r.customerName.toLowerCase() === String(f.customer).toLowerCase());
  if (f.orderType === "bulk" || f.orderType === "person_wise") out = out.filter((r) => r.orderType === f.orderType);
  if (f.status) {
    const s = String(f.status);
    out = out.filter((r) => (s === "active" ? r.productionStatus !== "completed" : s === "completed" ? r.productionStatus === "completed" : s === "not_started" ? r.productionStatus === "not_started" : s === "in_production" ? r.productionStatus === "in_production" : true));
  }
  if (f.risk) out = out.filter((r) => r.risk === f.risk);
  if (f.delayed === "1" || f.delayed === true) out = out.filter((r) => r.risk === "overdue" || r.risk === "at_risk");
  if (f.department) out = out.filter((r) => r.currentStage === f.department || r.nextStage === f.department);
  if (f.targetStatus) out = out.filter((r) => (f.targetStatus === "any" ? r.targets > 0 : r.targetStatus === f.targetStatus));
  if (f.product) out = out.filter((r) => (index.byMo.get(r.moId) || []).some((w) => w.product.toLowerCase().includes(String(f.product).toLowerCase())));
  if (f.variant) out = out.filter((r) => (index.byMo.get(r.moId) || []).some((w) => w.variant.toLowerCase().includes(String(f.variant).toLowerCase())));
  const dayStart = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? shift.istDayWindow(String(s)).start : null);
  const dayEnd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? shift.istDayWindow(String(s)).end : null);
  if (f.orderedFrom) { const t = dayStart(f.orderedFrom); if (t) out = out.filter((r) => r.orderDate && new Date(r.orderDate) >= t); }
  if (f.orderedTo) { const t = dayEnd(f.orderedTo); if (t) out = out.filter((r) => r.orderDate && new Date(r.orderDate) < t); }
  if (f.deliveryFrom) { const t = dayStart(f.deliveryFrom); if (t) out = out.filter((r) => r.deliveryDate && new Date(r.deliveryDate) >= t); }
  if (f.deliveryTo) { const t = dayEnd(f.deliveryTo); if (t) out = out.filter((r) => r.deliveryDate && new Date(r.deliveryDate) < t); }
  return out;
}

/* ── one order, in full ──────────────────────────────────────────────────── */

async function orderDetail(companyId, moId, asOfDay = todayKey()) {
  if (!isId(moId)) return null;
  const [headers, index] = await Promise.all([headersFor([moId]), ledger.woIndex(companyId, { moIds: [moId] })]);
  const h = headers.get(String(moId));
  if (!h) return null;
  const [events, targets, stds] = await Promise.all([
    ledger.readEvents(index), PpcOrderTarget.find({ companyId, manufacturingOrderId: oid(moId) }).sort({ assignedAt: -1 }).lean(), standards.standardsFor(companyId),
  ]);
  const wos = index.byMo.get(String(moId)) || [];
  const live = wos.filter((w) => w.status !== "cancelled");
  const quantity = live.reduce((n, w) => n + w.quantity, 0) || h.itemsQuantity;
  const pipeline = pipelineOf(quantity, events, targets, asOfDay);
  const stage = stageOf(pipeline, quantity);
  const produced = pipeline.find((p) => p.department === "production").done;
  const risk = riskOf(h, produced, quantity, events.get("production") || [], asOfDay);
  const standing = targetStanding(targets, events, quantity, asOfDay);
  const day = shift.istDayWindow(asOfDay);

  /* per work order, per department */
  const byWo = new Map();
  for (const [d, list] of events) for (const e of list) { if (!e.woId) continue; if (!byWo.has(e.woId)) byWo.set(e.woId, new Map()); const m = byWo.get(e.woId); if (!m.has(d)) m.set(d, []); m.get(d).push(e); }
  const workOrders = wos.map((w) => {
    const m = byWo.get(w.id) || new Map();
    const deps = DEPARTMENTS.map((d) => { const list = m.get(d) || []; const done = ledger.unitsOf(list); return { department: d, label: DEPARTMENT_META[d].label, done, remaining: Math.max(0, w.quantity - done), pct: pct(Math.min(done, w.quantity || done), w.quantity), today: sum(list.filter((e) => e.at >= day.start && e.at < day.end)), lastAt: lastAt(list), applicable: pipeline.find((p) => p.department === d).applicable }; });
    const active = deps.filter((x) => x.applicable);
    const withWork = active.filter((x) => x.done > 0);
    const current = withWork.length ? withWork[withWork.length - 1] : null;
    const next = active.find((x) => x.done < w.quantity) || null;
    const prod = deps.find((x) => x.department === "production");
    const allEvents = [...m.values()].flat();
    return {
      ...w, packagingRecords: undefined,
      produced: prod.done, remaining: prod.remaining, progressPct: prod.pct,
      currentStage: current?.department || null, currentStageLabel: current?.label || "Not started", nextStage: next?.department || null, nextStageLabel: next?.label || (active.every((x) => x.done >= w.quantity) && w.quantity ? "Complete" : "—"),
      productionStatus: w.status === "cancelled" ? "cancelled" : (w.quantity && active.every((x) => x.done >= w.quantity)) ? "completed" : withWork.length ? "in_production" : "not_started",
      lastActivityAt: lastAt(allEvents), lastActivityDepartment: current?.department || null,
      departments: deps,
      /* Units of this work order the sewing ledger has, and the ones it lacks. */
      units: unitLedger(w.quantity, m.get("production") || []),
    };
  });

  /* products → variants → work orders */
  /* A product is what a person reads: its name and reference. Two stock
     items with the same name and reference are one row here. */
  const products = [];
  const byProduct = groupBy(workOrders, (w) => `${w.product}|${w.reference}`);
  for (const [, list] of byProduct) {
    const first = list[0];
    const variants = [...groupBy(list, (w) => w.variant || "—").entries()].map(([variant, vlist]) => ({
      variant, size: vlist[0].size, colour: vlist[0].colour, attributes: vlist[0].variantAttributes,
      quantity: vlist.filter((w) => w.status !== "cancelled").reduce((n, w) => n + w.quantity, 0),
      produced: vlist.reduce((n, w) => n + w.produced, 0),
      departments: DEPARTMENTS.map((d) => ({ department: d, done: vlist.reduce((n, w) => n + w.departments.find((x) => x.department === d).done, 0) })),
      workOrders: vlist.map((w) => ({ id: w.id, number: w.number, quantity: w.quantity, produced: w.produced, progressPct: w.progressPct, currentStage: w.currentStage, currentStageLabel: w.currentStageLabel, status: w.status, productionStatus: w.productionStatus })),
    }));
    const qty = list.filter((w) => w.status !== "cancelled").reduce((n, w) => n + w.quantity, 0);
    const prodDone = list.reduce((n, w) => n + w.produced, 0);
    products.push({ stockItemId: first.stockItemId, product: first.product, reference: first.reference, category: first.category, genderCategory: first.genderCategory, image: first.image, quantity: qty, produced: prodDone, remaining: Math.max(0, qty - prodDone), progressPct: pct(Math.min(prodDone, qty || prodDone), qty), workOrders: list.length, variants });
  }

  /* department pipeline with targets in full and IE standard */
  const departments = pipeline.map((p) => {
    const mine = targets.filter((t) => t.department === p.department);
    const events_ = events.get(p.department) || [];
    const std = stds.get(p.department) || null;
    const evaluated = (t) => ({ ...ev.evaluateTarget(t, events_, asOfDay, { doneOverall: p.done, orderQuantity: quantity, standard: std }), description: ev.describeTarget(t), assignedBy: t.assignedBy, assignedAt: t.assignedAt, endStatus: t.status, endReason: t.endReason || "", endedAt: t.endedAt || null });
    const activeT = mine.find((t) => t.status === "active");
    const byDay = [...groupBy(events_, (e) => shift.istDayKeyOf(e.at)).entries()].map(([date, l]) => ({ date, pieces: sum(l) })).sort((a, b) => a.date.localeCompare(b.date));
    const people = [...groupBy(events_, (e) => e.personName || e.personKey || "").entries()].filter(([k]) => k).map(([name, l]) => ({ name, pieces: sum(l), lastAt: lastAt(l) })).sort((a, b) => b.pieces - a.pieces);
    return {
      ...p,
      standard: std ? { samMinutesPerPiece: std.samMinutesPerPiece, operators: std.operators, hoursPerDay: std.hoursPerDay, efficiencyPct: std.efficiencyPct, capacityPerDay: std.capacity?.perDay ?? null, capacityPerHour: std.capacity?.perHour ?? null, remainingTime: standards.timeFor(p.remaining, std) } : null,
      activeTarget: activeT ? evaluated(activeT) : null,
      targetHistory: mine.filter((t) => t.status !== "active").map(evaluated),
      byDay, people,
      workOrders: workOrders.filter((w) => w.departments.find((x) => x.department === p.department).done > 0).map((w) => ({ id: w.id, number: w.number, product: w.product, variant: w.variant, quantity: w.quantity, done: w.departments.find((x) => x.department === p.department).done })),
      efficiencyToday: std && p.today ? ev.efficiencyOf(p.today, { hoursFrom: "", hoursTo: "" }, asOfDay, std, new Date()) : null,
    };
  });

  return {
    asOfDay,
    order: { ...h, quantity, workOrders: live.length, cancelledWorkOrders: wos.length - live.length, products: products.length, variants: products.reduce((n, p) => n + p.variants.length, 0), produced, remaining: Math.max(0, quantity - produced), progressPct: pct(Math.min(produced, quantity || produced), quantity), packed: pipeline.find((p) => p.department === "packaging").done, dispatched: pipeline.find((p) => p.department === "dispatch").done, qcPassed: pipeline.find((p) => p.department === "qc").done, cut: pipeline.find((p) => p.department === "cutting").done, ...stage, ...risk, targetStatus: standing.status, targets: standing.count, targetsBehind: standing.behind, lastActivityAt: lastAt([...events.values()].flat()), planning: { workOrdersPlanned: live.filter((w) => ["complete", "released"].includes(w.planningState)).length, workOrdersNotPlanned: live.filter((w) => !["complete", "released"].includes(w.planningState)).length } },
    products, workOrders, departments,
    activity: recentActivity(events, 40),
  };
}

function unitLedger(quantity, productionEvents) {
  const have = new Set(productionEvents.map((e) => e.unit).filter((u) => Number.isFinite(u)));
  const missing = [];
  for (let u = 1; u <= quantity; u++) if (!have.has(u)) missing.push(u);
  return { have: have.size, missing: missing.length, missingRanges: compact(missing), beyond: [...have].filter((u) => u > quantity).length };
}
function compact(nums) {
  const out = []; let s = null, p = null;
  for (const n of nums) { if (s == null) { s = p = n; continue; } if (n === p + 1) { p = n; continue; } out.push(s === p ? `${s}` : `${s}–${p}`); s = p = n; }
  if (s != null) out.push(s === p ? `${s}` : `${s}–${p}`);
  return out.slice(0, 12).join(", ") + (out.length > 12 ? " …" : "");
}
function recentActivity(events, n) {
  return [...events.values()].flat().sort((a, b) => b.at - a.at).slice(0, n).map((e) => ({ at: e.at, department: e.department, label: DEPARTMENT_META[e.department].label, qty: e.qty, woId: e.woId, unit: e.unit, person: e.personName, source: e.source }));
}

/* ── work orders ─────────────────────────────────────────────────────────── */

async function listWorkOrders(companyId, filters = {}) {
  const index = await ledger.woIndex(companyId, filters.moId && isId(filters.moId) ? { moIds: [filters.moId] } : {});
  const moIds = [...index.byMo.keys()];
  const [headers, events] = await Promise.all([headersFor(moIds), ledger.readEvents(index)]);
  const byWo = new Map();
  for (const [d, list] of events) for (const e of list) { if (!e.woId) continue; if (!byWo.has(e.woId)) byWo.set(e.woId, new Map()); const m = byWo.get(e.woId); if (!m.has(d)) m.set(d, []); m.get(d).push(e); }
  const day = shift.istDayWindow();
  let rows = index.list.map((w) => {
    const h = headers.get(w.moId) || {};
    const m = byWo.get(w.id) || new Map();
    const deps = DEPARTMENTS.map((d) => { const l = m.get(d) || []; const done = ledger.unitsOf(l); return { department: d, done, pct: pct(Math.min(done, w.quantity || done), w.quantity), today: sum(l.filter((e) => e.at >= day.start && e.at < day.end)), lastAt: lastAt(l) }; });
    const withWork = deps.filter((x) => x.done > 0 && (!FINISHING.has(x.department) || true));
    const current = withWork.length ? withWork[withWork.length - 1] : null;
    const core = deps.filter((x) => !FINISHING.has(x.department) || x.done > 0);
    const next = core.find((x) => x.done < w.quantity) || null;
    const prod = deps.find((x) => x.department === "production");
    return {
      ...w, packagingRecords: undefined, recorded: w.recorded,
      moNumber: h.moNumber || "", poNumber: h.poNumber || "", customerName: h.customerName || w.customerName, orderType: h.orderType || "", deliveryDate: h.deliveryDate || null,
      produced: prod.done, remaining: Math.max(0, w.quantity - prod.done), progressPct: prod.pct,
      currentStage: current?.department || null, currentStageLabel: current ? DEPARTMENT_META[current.department].label : "Not started",
      nextStage: next?.department || null, nextStageLabel: next ? DEPARTMENT_META[next.department].label : (w.quantity && core.every((x) => x.done >= w.quantity) ? "Complete" : "—"),
      productionStatus: w.status === "cancelled" ? "cancelled" : (w.quantity && core.every((x) => x.done >= w.quantity)) ? "completed" : withWork.length ? "in_production" : "not_started",
      lastActivityAt: lastAt([...m.values()].flat()), departments: deps,
    };
  });
  const q = String(filters.q || "").trim().toLowerCase();
  if (q) rows = rows.filter((r) => [r.number, r.shortId, r.moNumber, r.poNumber, r.customerName, r.product, r.reference, r.variant].some((s) => String(s || "").toLowerCase().includes(q)));
  if (filters.status) rows = rows.filter((r) => (filters.status === "active" ? !["completed", "cancelled"].includes(r.productionStatus) : r.productionStatus === filters.status));
  if (filters.department) rows = rows.filter((r) => r.currentStage === filters.department || r.nextStage === filters.department);
  if (filters.product) rows = rows.filter((r) => r.product.toLowerCase().includes(String(filters.product).toLowerCase()));
  if (filters.variant) rows = rows.filter((r) => r.variant.toLowerCase().includes(String(filters.variant).toLowerCase()));
  if (filters.orderType) rows = rows.filter((r) => r.orderType === filters.orderType);
  if (filters.customer) rows = rows.filter((r) => r.customerName.toLowerCase() === String(filters.customer).toLowerCase());
  rows.sort((a, b) => (new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
  const total = rows.length;
  const page = Math.max(1, Number(filters.page) || 1), limit = Math.min(300, Math.max(1, Number(filters.limit) || 60));
  return { rows: rows.slice((page - 1) * limit, page * limit), total, page, limit };
}

async function workOrderDetail(companyId, woId) {
  if (!isId(woId)) return null;
  const index = await ledger.woIndex(companyId, { woIds: [woId] });
  const w = index.byId.get(String(woId));
  if (!w) return null;
  const [headers, events] = await Promise.all([headersFor([w.moId]), ledger.readEvents(index)]);
  const h = headers.get(w.moId) || null;
  const day = shift.istDayWindow();
  const departments = DEPARTMENTS.map((d) => {
    const l = events.get(d) || [];
    const done = ledger.unitsOf(l);
    const byDay = [...groupBy(l, (e) => shift.istDayKeyOf(e.at)).entries()].map(([date, x]) => ({ date, pieces: sum(x) })).sort((a, b) => a.date.localeCompare(b.date));
    const people = [...groupBy(l, (e) => e.personName || e.personKey || "").entries()].filter(([k]) => k).map(([name, x]) => ({ name, pieces: sum(x), lastAt: lastAt(x) })).sort((a, b) => b.pieces - a.pieces);
    return { department: d, label: DEPARTMENT_META[d].label, doneWord: DEPARTMENT_META[d].done, applicable: !FINISHING.has(d) || l.length > 0, done, remaining: Math.max(0, w.quantity - done), pct: pct(Math.min(done, w.quantity || done), w.quantity), today: sum(l.filter((e) => e.at >= day.start && e.at < day.end)), firstAt: firstAt(l), lastAt: lastAt(l), byDay, people, units: unitLedger(w.quantity, l.filter((e) => e.unit != null || (e.units && e.units.length)).flatMap((e) => (e.units && e.units.length ? e.units.map((u) => ({ unit: u })) : [e]))) };
  });
  const active = departments.filter((x) => x.applicable);
  const withWork = active.filter((x) => x.done > 0);
  const current = withWork.length ? withWork[withWork.length - 1] : null;
  const next = active.find((x) => x.done < w.quantity) || null;
  const prod = departments.find((x) => x.department === "production");
  const all = [...events.values()].flat();
  /* the people this work order's units are for, on a person-wise order */
  const persons = await EmployeeProductionProgress.find({ workOrderId: oid(woId) }).select("employeeId employeeName employeeUIN unitStart unitEnd totalUnits completedUnits completionPercentage isDispatched cutDone").lean();
  return {
    workOrder: { ...w, packagingRecords: undefined, produced: prod.done, remaining: prod.remaining, progressPct: prod.pct, currentStage: current?.department || null, currentStageLabel: current?.label || "Not started", nextStage: next?.department || null, nextStageLabel: next?.label || (w.quantity && active.every((x) => x.done >= w.quantity) ? "Complete" : "—"), productionStatus: w.status === "cancelled" ? "cancelled" : (w.quantity && active.every((x) => x.done >= w.quantity)) ? "completed" : withWork.length ? "in_production" : "not_started", lastActivityAt: lastAt(all), firstActivityAt: firstAt(all) },
    order: h, departments,
    persons: persons.map((p) => ({ progressId: String(p._id), employeeId: p.employeeId ? String(p.employeeId) : "", name: p.employeeName || "", uin: p.employeeUIN || "", unitStart: p.unitStart, unitEnd: p.unitEnd, totalUnits: p.totalUnits, completedUnits: p.completedUnits, completionPct: p.completionPercentage, isDispatched: Boolean(p.isDispatched), cutDone: Boolean(p.cutDone) })),
    activity: all.sort((a, b) => b.at - a.at).slice(0, 60).map((e) => ({ at: e.at, department: e.department, label: DEPARTMENT_META[e.department].label, qty: e.qty, unit: e.unit, person: e.personName, source: e.source })),
  };
}

/* ── person-wise (MPC / measurement) orders ──────────────────────────────── */

/**
 * Every person on a person-wise order, with the units assigned to them and
 * what each department has done on exactly those units. A department that
 * records units (finishing, sewing, QC, packing) is counted unit by unit; one
 * that does not (cutting, dispatch) is read from the person's progress record
 * and the challans that name them.
 */
async function personWise(companyId, moId) {
  if (!isId(moId)) return null;
  const [headers, index] = await Promise.all([headersFor([moId]), ledger.woIndex(companyId, { moIds: [moId] })]);
  const h = headers.get(String(moId));
  if (!h) return null;
  const [events, progress] = await Promise.all([ledger.readEvents(index), EmployeeProductionProgress.find({ manufacturingOrderId: oid(moId) }).select("employeeId employeeName employeeUIN gender workOrderId unitStart unitEnd totalUnits completedUnits completedUnitNumbers completionPercentage isDispatched cutDone cutDoneAt packagedUnits isFullyPackaged dispatchHistory").lean()]);
  const UNIT_DEPTS = DEPARTMENTS.filter((d) => d !== "cutting" && d !== "dispatch");
  const unitSets = new Map(); // woId → dept → Set(unit)
  for (const d of UNIT_DEPTS) for (const e of events.get(d) || []) {
    if (!e.woId) continue;
    if (!unitSets.has(e.woId)) unitSets.set(e.woId, new Map());
    const m = unitSets.get(e.woId); if (!m.has(d)) m.set(d, new Set());
    if (Array.isArray(e.units) && e.units.length) e.units.forEach((u) => m.get(d).add(u)); else if (e.unit != null) m.get(d).add(e.unit);
  }
  const dispatchByPerson = groupBy((events.get("dispatch") || []).filter((e) => e.personKey), (e) => e.personKey);
  const people = new Map();
  for (const p of progress) {
    const wo = index.byId.get(String(p.workOrderId));
    const key = p.employeeUIN || String(p.employeeId || p.employeeName);
    if (!people.has(key)) people.set(key, { key, employeeId: p.employeeId ? String(p.employeeId) : "", name: p.employeeName || "", uin: p.employeeUIN || "", gender: p.gender || "", products: [], totalUnits: 0 });
    const person = people.get(key);
    const units = []; for (let u = p.unitStart; u <= p.unitEnd; u++) units.push(u);
    const m = unitSets.get(wo?.id) || new Map();
    const deps = DEPARTMENTS.map((d) => {
      let done;
      if (d === "cutting") done = p.cutDone ? units.length : Math.min(units.length, wo ? Math.round((wo.recorded.cuttingCompleted / (wo.quantity || 1)) * units.length) : 0);
      else if (d === "dispatch") done = p.isDispatched ? units.length : 0;
      else { const set = m.get(d) || new Set(); done = units.filter((u) => set.has(u)).length; }
      return { department: d, label: DEPARTMENT_META[d].label, done, total: units.length, pct: pct(done, units.length), applicable: !FINISHING.has(d) || (m.get(d)?.size || 0) > 0 };
    });
    const active = deps.filter((x) => x.applicable);
    const withWork = active.filter((x) => x.done > 0);
    const current = withWork.length ? withWork[withWork.length - 1] : null;
    const complete = active.every((x) => x.done >= x.total);
    person.products.push({
      progressId: String(p._id), workOrderId: wo?.id || String(p.workOrderId), workOrderNumber: wo?.number || "", product: wo?.product || "", reference: wo?.reference || "", variant: wo?.variant || "", size: wo?.size || "", image: wo?.image || null,
      unitStart: p.unitStart, unitEnd: p.unitEnd, totalUnits: units.length,
      produced: deps.find((x) => x.department === "production").done, qcPassed: deps.find((x) => x.department === "qc").done, packed: deps.find((x) => x.department === "packaging").done,
      recordedCompleted: p.completedUnits || 0, recordedPct: p.completionPercentage || 0, isDispatched: Boolean(p.isDispatched), cutDone: Boolean(p.cutDone), cutDoneAt: p.cutDoneAt || null,
      currentStage: current?.department || null, currentStageLabel: current?.label || "Not started", completedDepartments: active.filter((x) => x.done >= x.total && x.total).map((x) => x.department), pendingDepartments: active.filter((x) => x.done < x.total).map((x) => x.department),
      status: complete && units.length ? "completed" : withWork.length ? "in_production" : "not_started", completionPct: pct(active.reduce((n, x) => n + x.done, 0), active.reduce((n, x) => n + x.total, 0)),
      departments: deps, dispatchedByChallan: (dispatchByPerson.get(p.employeeUIN) || []).reduce((n, e) => n + e.qty, 0),
    });
    person.totalUnits += units.length;
  }
  const rows = [...people.values()].map((p) => {
    const tot = p.products.reduce((n, x) => n + x.totalUnits, 0);
    const doneUnits = p.products.reduce((n, x) => n + x.departments.filter((d) => d.applicable).reduce((m, d) => m + d.done, 0), 0);
    const totUnits = p.products.reduce((n, x) => n + x.departments.filter((d) => d.applicable).reduce((m, d) => m + d.total, 0), 0);
    const produced = p.products.reduce((n, x) => n + x.produced, 0);
    const dispatched = p.products.filter((x) => x.isDispatched).reduce((n, x) => n + x.totalUnits, 0);
    const stages = p.products.map((x) => x.currentStage).filter(Boolean);
    const furthest = stages.sort((a, b) => DEPARTMENT_META[b].order - DEPARTMENT_META[a].order)[0] || null;
    return { ...p, totalUnits: tot, produced, dispatched, completionPct: pct(doneUnits, totUnits), status: p.products.every((x) => x.status === "completed") ? "completed" : p.products.some((x) => x.status !== "not_started") ? "in_production" : "not_started", currentStage: furthest, currentStageLabel: furthest ? DEPARTMENT_META[furthest].label : "Not started" };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const summary = { persons: rows.length, units: rows.reduce((n, r) => n + r.totalUnits, 0), produced: rows.reduce((n, r) => n + r.produced, 0), dispatched: rows.reduce((n, r) => n + r.dispatched, 0), completed: rows.filter((r) => r.status === "completed").length, inProduction: rows.filter((r) => r.status === "in_production").length, notStarted: rows.filter((r) => r.status === "not_started").length,
    departments: DEPARTMENTS.map((d) => ({ department: d, label: DEPARTMENT_META[d].label, done: rows.reduce((n, r) => n + r.products.reduce((m, x) => m + x.departments.find((y) => y.department === d).done, 0), 0) })) };
  return { order: h, summary, persons: rows };
}

/** Person-wise orders across the company, one row per order with its people. */
async function personWiseOrders(companyId, filters = {}) {
  const list = await listOrders(companyId, { ...filters, orderType: "person_wise", limit: 500 });
  const moIds = list.rows.map((r) => r.moId);
  const counts = moIds.length ? await EmployeeProductionProgress.aggregate([{ $match: { manufacturingOrderId: { $in: moIds.map(oid) } } }, { $group: { _id: "$manufacturingOrderId", persons: { $addToSet: "$employeeUIN" }, dispatched: { $sum: { $cond: ["$isDispatched", 1, 0] } }, docs: { $sum: 1 }, units: { $sum: "$totalUnits" } } }]) : [];
  const byMo = new Map(counts.map((c) => [String(c._id), c]));
  return { ...list, rows: list.rows.map((r) => { const c = byMo.get(r.moId); return { ...r, persons: c ? c.persons.filter(Boolean).length : r.persons, personProducts: c?.docs || 0, personProductsDispatched: c?.dispatched || 0, personUnits: c?.units || 0 }; }) };
}

/* ── search ──────────────────────────────────────────────────────────────── */

async function search(companyId, qRaw) {
  const q = String(qRaw || "").trim();
  if (q.length < 2) return { q, hits: [] };
  const lower = q.toLowerCase();
  const index = await ledger.woIndex(companyId);
  const headers = await headersFor([...index.byMo.keys()]);
  const hits = [];
  const bc = ledger.resolveBarcode(index, q);
  if (bc) hits.push({ type: "barcode", label: q.toUpperCase(), detail: `Unit ${bc.unit} of ${bc.wo.number} · ${bc.wo.product}${bc.wo.variant ? ` · ${bc.wo.variant}` : ""}`, woId: bc.wo.id, moId: bc.wo.moId, unit: bc.unit, matched: "barcode" });
  for (const h of headers.values()) {
    const fields = [["moNumber", h.moNumber], ["requestId", h.requestId], ["poNumber", h.poNumber], ["customer", h.customerName], ["measurement", h.measurementName]];
    const m = fields.find(([, v]) => String(v || "").toLowerCase().includes(lower));
    if (m) hits.push({ type: "order", label: h.moNumber, detail: `${h.customerName}${h.poNumber ? ` · PO ${h.poNumber}` : ""}`, moId: h.moId, matched: m[0], matchedValue: m[1] });
  }
  for (const w of index.list) {
    const h = headers.get(w.moId);
    const fields = [["workOrderNumber", w.number], ["shortId", w.shortId], ["product", w.product], ["reference", w.reference], ["variant", w.variant]];
    const m = fields.find(([, v]) => String(v || "").toLowerCase().includes(lower));
    if (m) hits.push({ type: "workOrder", label: w.number, detail: `${w.product}${w.variant ? ` · ${w.variant}` : ""} · ${h?.moNumber || ""} · ${h?.customerName || w.customerName}`, woId: w.id, moId: w.moId, matched: m[0], matchedValue: m[1] });
  }
  const products = new Map();
  for (const w of index.list) if (w.product.toLowerCase().includes(lower) || w.reference.toLowerCase().includes(lower)) { const k = w.stockItemId || w.product; if (!products.has(k)) products.set(k, { type: "product", label: w.product, detail: `${w.reference ? `${w.reference} · ` : ""}`, product: w.product, stockItemId: w.stockItemId, orders: new Set(), workOrders: 0, matched: "product" }); const p = products.get(k); p.orders.add(w.moId); p.workOrders += 1; }
  for (const p of products.values()) hits.push({ ...p, orders: p.orders.size, detail: `${p.detail}${p.orders.size} order${p.orders.size === 1 ? "" : "s"} · ${p.workOrders} work order${p.workOrders === 1 ? "" : "s"}` });
  const order = { barcode: 0, order: 1, workOrder: 2, product: 3 };
  hits.sort((a, b) => order[a.type] - order[b.type]);
  return { q, hits: hits.slice(0, 60) };
}

module.exports = { snapshot, summariseOrders, applyFilters, headersFor, headerOf, poOf, orderTypeOf, pipelineOf, stageOf, riskOf, targetStanding, listOrders, orderDetail, listWorkOrders, workOrderDetail, personWise, personWiseOrders, search, todayKey, pct };
