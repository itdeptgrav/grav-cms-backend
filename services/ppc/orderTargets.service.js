// services/ppc/orderTargets.service.js
//
// ORDER TARGETS — the data half. What each department has actually DONE on an
// order is read from that department's own book (nothing is ever typed in):
//
//   cutting     CuttingMasterRecord entries (quantityCut at timestamp)
//   embroidery, printing, washing, trimming, ironing
//               FinishingScan, one row per piece (doneAt)
//   production  ProductionCompletionScanRecord scans — the Production Record
//               page's mark-done ledger (scannedAt), matched to the order's
//               work orders by the barcode's short id
//   qc          QC inspections that PASSED (inspectedAt), one per piece
//   packaging   WorkOrder.packagingRecords (packagedAt, packagedQuantity)
//   dispatch    DispatchChallan (totalUnits at createdAt)
//
// Everything is per manufacturing order, the grain a target is set at.
"use strict";

const mongoose = require("mongoose");
const PpcOrderTarget = require("../../models/CMS_Models/PPC/PpcOrderTarget");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const FinishingScan = require("../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const ProductionCompletionScanRecord = require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const QCInspection = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const DispatchChallan = require("../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const packagingAccess = require("../../routes/CMS_Routes/Manufacturing/Packaging/packagingAccess");
const { displayWorkOrderNumber } = require("../manufacturing/workOrderNumber");
const ev = require("./orderTargets.evaluate");
const scopes = require("./targetScope");
const curve = require("./targetCurve");
const cutPlan = require("./cutPlan");
const standards = require("../industrialEngineering/departmentStandards.service");

const { DEPARTMENTS, KINDS } = PpcOrderTarget;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const FINISHING = new Set(["embroidery", "printing", "washing", "trimming", "ironing"]);

/* ── the order and its work orders ───────────────────────────────────────── */

/** One variant attribute's value, by a pattern on its name ("Size", "Colour"). */
function attrOf(attrs, pattern) {
  const a = (Array.isArray(attrs) ? attrs : []).find((x) => pattern.test(String(x?.name || "")));
  return a?.value == null ? "" : String(a.value);
}

async function orderContext(companyId, moId) {
  const [mo, wos] = await Promise.all([
    CustomerRequest.findById(moId).select("requestId customerInfo.name customerInfo.deliveryDeadline requestType status dueDate items").lean(),
    packagingAccess.findWorkOrders(companyId, { customerRequestId: oid(moId) }, "_id workOrderNumber quantity stockItemName variantAttributes status packagingRecords assignedDeadline").lean(),
  ]);
  if (!mo) return null;
  const quantity = wos.reduce((n, w) => n + (w.quantity || 0), 0)
    || (mo.items || []).reduce((n, i) => n + (i.totalQuantity || 0), 0);
  return {
    mo, wos,
    moId: String(mo._id), moNumber: mo.requestId ? `MO-${mo.requestId}` : "", customerName: mo.customerInfo?.name || "",
    requestType: mo.requestType || "", status: mo.status || "", dueDate: mo.dueDate || null,
    /* PPC's target date: the latest work-order deadline Sales assigned, else
       the customer's delivery date (7 Oct 2026, owner) — the same rule the
       control center's order rows apply. */
    ...(() => {
      const ds = wos.filter((w) => w.status !== "cancelled" && w.assignedDeadline).map((w) => new Date(w.assignedDeadline).getTime()).filter((t) => !Number.isNaN(t));
      const sales = ds.length ? new Date(Math.max(...ds)) : null;
      return { deliveryDate: sales || mo.customerInfo?.deliveryDeadline || null, deliveryDateSource: sales ? "sales_wo" : (mo.customerInfo?.deliveryDeadline ? "customer" : ""), customerDeliveryDate: mo.customerInfo?.deliveryDeadline || null };
    })(),
    quantity, workOrderIds: wos.map((w) => w._id), shortIds: new Set(wos.map((w) => String(w._id).slice(-8).toLowerCase())),
    /* Size and colour ride along (16 Oct 2026): the cut order plan groups
       the work orders' quantities colour × size, and the variant attributes
       are where the order says which is which. */
    workOrders: wos.map((w) => ({
      id: String(w._id), number: displayWorkOrderNumber(w), product: w.stockItemName || "", quantity: w.quantity || 0,
      size: attrOf(w.variantAttributes, /size/i), colour: attrOf(w.variantAttributes, /colou?r|shade/i),
    })),
  };
}

/** Every order this company can plan for: those with at least one work order. */
async function listOrders(companyId) {
  const wos = await packagingAccess.findWorkOrders(companyId, {}, "_id customerRequestId quantity status").lean();
  const byMo = new Map();
  for (const w of wos) {
    if (!w.customerRequestId) continue;
    const k = String(w.customerRequestId);
    const row = byMo.get(k) || { moId: k, quantity: 0, workOrders: 0 };
    row.quantity += w.quantity || 0; row.workOrders += 1;
    byMo.set(k, row);
  }
  const ids = [...byMo.keys()];
  if (!ids.length) return [];
  const [mos, targets] = await Promise.all([
    CustomerRequest.find({ _id: { $in: ids.map(oid) } }).select("requestId customerInfo.name requestType status dueDate createdAt").lean(),
    PpcOrderTarget.find({ companyId, manufacturingOrderId: { $in: ids.map(oid) }, status: "active" }).select("manufacturingOrderId department to").lean(),
  ]);
  const tByMo = new Map();
  for (const t of targets) { const k = String(t.manufacturingOrderId); tByMo.set(k, (tByMo.get(k) || []).concat(t)); }
  return mos.map((m) => {
    const r = byMo.get(String(m._id));
    const ts = tByMo.get(String(m._id)) || [];
    return {
      moId: String(m._id), moNumber: m.requestId ? `MO-${m.requestId}` : "", customerName: m.customerInfo?.name || "",
      requestType: m.requestType || "", status: m.status || "", dueDate: m.dueDate || null, createdAt: m.createdAt,
      quantity: r.quantity, workOrders: r.workOrders,
      targets: ts.length, targetedDepartments: [...new Set(ts.map((t) => t.department))],
    };
  }).sort((a, b) => (b.targets - a.targets) || new Date(b.createdAt) - new Date(a.createdAt));
}

/* ── what was DONE, per department ───────────────────────────────────────── */

/**
 * Completion events for one department on one order: `[{ at, qty, woId }]`.
 * `start`/`end` bound the read (null = all time).
 *
 * `woId` is the work order the piece belonged to, where the department's own
 * book names it — which is every department except Dispatch, whose challan
 * counts units for the order. It is what lets a target be asked against a MIX
 * of work orders rather than the whole order (16 Oct 2026); a reader that does
 * not scope simply ignores it, so nothing that counted before counts
 * differently now.
 */
async function doneEvents(department, ctx, start = null, end = null) {
  const inRange = (field) => (start || end ? { [field]: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } } : {});
  const moId = oid(ctx.moId);
  if (FINISHING.has(department)) {
    const rows = await FinishingScan.find({ stage: department, manufacturingOrderId: moId, ...inRange("doneAt") }).select("doneAt workOrderId").lean();
    return rows.map((r) => ({ at: r.doneAt, qty: 1, woId: r.workOrderId ? String(r.workOrderId) : null }));
  }
  if (department === "cutting") {
    if (!ctx.workOrderIds.length) return [];
    const woSet = new Set(ctx.workOrderIds.map(String));
    const docs = await CuttingMasterRecord.find({ "entries.woId": { $in: ctx.workOrderIds } }).select("entries.woId entries.quantityCut entries.timestamp").lean();
    const out = [];
    for (const d of docs) for (const e of d.entries || []) {
      if (!e.woId || !woSet.has(String(e.woId))) continue;
      const at = e.timestamp; if (start && at < start) continue; if (end && at >= end) continue;
      out.push({ at, qty: e.quantityCut || 0, woId: String(e.woId) });
    }
    return out;
  }
  if (department === "production") {
    if (!ctx.shortIds.size) return [];
    /* Day documents are keyed by the IST day; read a day either side of the
       bounds and let scannedAt decide. */
    const q = {};
    if (start) q.$gte = new Date(start.getTime() - 86400000);
    if (end) q.$lte = new Date(end.getTime() + 86400000);
    const docs = await ProductionCompletionScanRecord.find(Object.keys(q).length ? { date: q } : {}).select("scans.barcodeId scans.scannedAt").lean();
    /* The barcode's eight characters are the work order's id tail, so the
       scan names its work order without a second read. */
    const byShort = new Map(ctx.workOrderIds.map((id) => [String(id).slice(-8).toLowerCase(), String(id)]));
    const seen = new Set(); const out = [];
    for (const d of docs) for (const s of d.scans || []) {
      const m = /^WO-([0-9a-f]{8})-\d+$/i.exec(String(s.barcodeId || "")); if (!m || !ctx.shortIds.has(m[1].toLowerCase())) continue;
      const key = s.barcodeId.toUpperCase(); if (seen.has(key)) continue; seen.add(key);
      const at = s.scannedAt || d.date; if (start && at < start) continue; if (end && at >= end) continue;
      out.push({ at, qty: 1, woId: byShort.get(m[1].toLowerCase()) || null });
    }
    return out;
  }
  if (department === "qc") {
    const rows = await QCInspection.find({ manufacturingOrderId: moId, status: "passed", ...inRange("inspectedAt") }).select("barcodeId inspectedAt workOrderId").sort({ inspectedAt: 1 }).lean();
    const seen = new Set(); const out = [];
    for (const r of rows) { if (seen.has(r.barcodeId)) continue; seen.add(r.barcodeId); out.push({ at: r.inspectedAt, qty: 1, woId: r.workOrderId ? String(r.workOrderId) : null }); }
    return out;
  }
  if (department === "packaging") {
    const out = [];
    for (const w of ctx.wos) for (const r of w.packagingRecords || []) {
      const at = r.packagedAt; if (!at) continue; if (start && at < start) continue; if (end && at >= end) continue;
      out.push({ at, qty: r.packagedQuantity || (r.unitNumbers || []).length, woId: String(w._id) });
    }
    return out;
  }
  if (department === "dispatch") {
    /* A challan counts units for the ORDER: it names no work order, which is
       why `targetScope` refuses a scoped dispatch target rather than guessing. */
    const rows = await DispatchChallan.find({ manufacturingOrderId: moId, ...inRange("createdAt") }).select("totalUnits createdAt").lean();
    return rows.map((r) => ({ at: r.createdAt, qty: r.totalUnits || 0, woId: null }));
  }
  return [];
}

const sum = (events) => events.reduce((n, e) => n + (Number(e.qty) || 0), 0);

/* One target, evaluated against the events its scope asked for. */
function viewTarget(t, events, asOfDay, ctx, doneOverall, std) {
  const scope = t.scope && t.scope.kind ? (t.scope.toObject?.() || t.scope) : { kind: "order" };
  const scoped = scope.kind === "work_orders";
  const mine = scoped ? scopes.scopedEvents(events, scope) : events;
  const quantity = scoped ? (scope.quantity ?? ctx.quantity) : ctx.quantity;
  const done = scoped ? sum(mine) : doneOverall;
  /* Line by line: what each allocated work order has done INSIDE the
     target's own days, against what it was asked. */
  const span = ev.targetDays(t);
  const allocations = (scope.allocations || []).map((a) => {
    const wo = (ctx.workOrders || []).find((w) => String(w.id) === String(a.workOrderId));
    const own = events.filter((e) => String(e.woId) === String(a.workOrderId));
    const doneInSpan = span.reduce((nn, d) => nn + ev.doneOn(own, t, d), 0);
    return { workOrderId: String(a.workOrderId), number: wo?.number || "", product: wo?.product || "", size: wo?.size || "", colour: wo?.colour || "", quantity: a.quantity, done: doneInSpan, left: Math.max(0, a.quantity - doneInSpan) };
  });
  const cut = t.department === "cutting" && t.cutPlan
    ? cutPlan.evaluate(t.cutPlan, (allocations.length ? allocations : (ctx.workOrders || []).map((w) => ({ ...w, quantity: w.quantity }))).map((a) => ({ colour: a.colour, size: a.size, quantity: a.quantity })))
    : null;
  return {
    ...ev.evaluateTarget(t, mine, asOfDay, { doneOverall: done, orderQuantity: quantity, standard: std }),
    allocations, cutPlan: cut,
    scope, scopeLabel: scopes.describeScope(scope),
    assignedBy: t.assignedBy, assignedAt: t.assignedAt,
    description: ev.describeTarget(t), assessment: t.assessment || null,
  };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

/** The order, with every department's standing and its targets (active + past). */
async function orderDetail(companyId, moId, asOfDay) {
  const ctx = await orderContext(companyId, moId);
  if (!ctx) return null;
  const [targets, stds, othersActive] = await Promise.all([
    PpcOrderTarget.find({ companyId, manufacturingOrderId: oid(moId) }).sort({ assignedAt: -1 }).lean(),
    standards.standardsFor(companyId),
    /* Every active target this company has on OTHER orders — the "busy" check. */
    PpcOrderTarget.find({ companyId, status: "active", manufacturingOrderId: { $ne: oid(moId) }, to: { $gte: ev.shiftDay(asOfDay, -1) } }).lean(),
  ]);
  const departments = [];
  /* Read every department's book at once (27 Sep 2026): ten sequential reads
     were most of this page's wait. */
  const eventsByDept = new Map(await Promise.all(DEPARTMENTS.map(async (d) => [d, await doneEvents(d, ctx)])));
  for (const department of DEPARTMENTS) {
    const events = eventsByDept.get(department);
    const doneOverall = sum(events);
    const mine = targets.filter((t) => t.department === department);
    const actives = mine.filter((t) => t.status === "active");
    const active = actives[0] || null;
    const std = stds.get(department) || null;
    const elsewhere = othersActive.filter((o) => o.department === department && o.from <= asOfDay && o.to >= asOfDay);
    departments.push({
      department, ...ev.DEPARTMENT_META[department],
      doneOverall, orderQuantity: ctx.quantity, remaining: Math.max(0, ctx.quantity - doneOverall),
      pct: ctx.quantity ? Math.round((doneOverall / ctx.quantity) * 100) : 0,
      lastAt: events.length ? events.reduce((m, e) => (new Date(e.at) > m ? new Date(e.at) : m), new Date(0)) : null,
      standard: std ? { samMinutesPerPiece: std.samMinutesPerPiece, operators: std.operators, hoursPerDay: std.hoursPerDay, efficiencyPct: std.efficiencyPct, capacityPerDay: std.capacity?.perDay ?? null, capacityPerHour: std.capacity?.perHour ?? null,
        /* How long what is LEFT of this order takes here, at standard. */
        remainingTime: standards.timeFor(Math.max(0, ctx.quantity - doneOverall), std) } : null,
      /* What this department is doing today for other orders. */
      busyToday: elsewhere.map((o) => ({ moNumber: o.moNumber, perDay: Math.round(ev.expectedPerDay(o)), to: o.to })),
      /* A target is evaluated against the events IT asked for: a scoped one
         sees only its work orders, and its "order quantity" is what that
         scope was worth. An unscoped one is the order, exactly as before. */
      active: active ? viewTarget(active, events, asOfDay, ctx, doneOverall, std) : null,
      /* Targets standing at the same time on OTHER work orders (16 Oct 2026).
         `active` stays the first for every reader written before scoping. */
      actives: actives.map((t) => viewTarget(t, events, asOfDay, ctx, doneOverall, std)),
      past: mine.filter((t) => t.status !== "active" && t.status !== "proposed").map((t) => ({ ...viewTarget(t, events, asOfDay, ctx, doneOverall, std), endStatus: t.status, endReason: t.endReason, endedAt: t.endedAt })),
    });
  }
  const { mo, wos, workOrderIds, shortIds, ...header } = ctx;
  return { order: header, asOfDay, departments };
}

/**
 * A department's targets that cover a day, evaluated — what its overview shows.
 * Not company-scoped: the targets were company-scoped when set, and a
 * department overview is already inside its own portal.
 */
async function departmentDay(department, asOfDay) {
  if (!DEPARTMENTS.includes(department)) return { targets: [], upcoming: [] };
  /* Running or just ended (last 7 days), AND starting in the next 14 days —
     27 Sep 2026: "the upcoming assigned targets also can showcase".
     A target whose last day has passed with pieces still owed is NOT ended
     (17 Oct 2026, owner: "even if the date passes it should not matter …
     there might be a delay"): every active target is read, and one that is
     over stays while anything is left to make, carrying what is still owed
     (`carryOver`) until it is met or PPC ends or replaces it. */
  const targets = await PpcOrderTarget.find({ department, status: "active", from: { $lte: ev.shiftDay(asOfDay, 14) } })
    .sort({ from: 1 }).lean();
  /* one order read and one standard read per order/company, all at once */
  const ctxByMo = new Map(); const stdByCo = new Map();
  await Promise.all([...new Set(targets.map((t) => String(t.manufacturingOrderId)))].map(async (mo) => {
    const t = targets.find((x) => String(x.manufacturingOrderId) === mo);
    const ctx = await orderContext(t.companyId, mo);
    ctxByMo.set(mo, ctx ? { ctx, events: await doneEvents(department, ctx) } : null);
  }));
  await Promise.all([...new Set(targets.map((t) => String(t.companyId)))].map(async (co) => { stdByCo.set(co, await standards.standardFor(co, department)); }));
  const out = [];
  for (const t of targets) {
    const hit = ctxByMo.get(String(t.manufacturingOrderId));
    if (!hit) continue;
    const { ctx, events } = hit;
    const doneOverall = sum(events);
    out.push({
      ...ev.evaluateTarget(t, events, asOfDay, { doneOverall, orderQuantity: ctx.quantity, standard: stdByCo.get(String(t.companyId)) }),
      moId: ctx.moId, moNumber: ctx.moNumber, customerName: ctx.customerName, deliveryDate: ctx.deliveryDate, description: ev.describeTarget(t), assignedBy: t.assignedBy?.name || "",
      startsInDays: t.from > asOfDay ? Math.round((Date.parse(t.from) - Date.parse(asOfDay)) / 86400000) : 0,
    });
    const e = out[out.length - 1];
    /* what was made AFTER the last day still pays the target off — late is
       late, but it is done (whole days, whatever the target's hours were) */
    let late = 0;
    if (e.over) { const day = { ...t, hoursFrom: "", hoursTo: "" }; for (let d = ev.shiftDay(t.to, 1); d <= asOfDay; d = ev.shiftDay(d, 1)) late += ev.doneOn(events, day, d); }
    let owed = Math.max(0, (Number(e.span?.remaining) || 0) - late);
    /* never more than the order itself still has to make */
    if (ctx.quantity > 0) owed = Math.min(owed, Math.max(0, ctx.quantity - doneOverall));
    if (e.over && owed > 0) e.carryOver = { remaining: owed, doneLate: late, daysOver: Math.round((Date.parse(asOfDay) - Date.parse(t.to)) / 86400000) };
    /* an over target met in full drops off after its week, as before */
    else if (e.over && t.to < ev.shiftDay(asOfDay, -7)) out.pop();
  }
  const upcoming = out.filter((x) => x.from > asOfDay).sort((a, b) => a.from.localeCompare(b.from));
  const current = out.filter((x) => x.from <= asOfDay);
  /* Today's targets first, then ones that just ended (still worth a glance). */
  current.sort((a, b) => (b.covers - a.covers) || (Boolean(b.carryOver) - Boolean(a.carryOver)) || a.from.localeCompare(b.from));
  const covering = current.filter((x) => x.covers);
  const summary = {
    targets: covering.length,
    expectedToday: covering.reduce((n, x) => n + (x.today?.expected || 0), 0),
    doneToday: covering.reduce((n, x) => n + (x.today?.done || 0), 0),
    behind: covering.filter((x) => x.status === "behind").length,
    achieved: covering.filter((x) => x.status === "achieved" || x.status === "exceeded").length,
    /* past their last day with pieces still owed */
    overdue: current.filter((x) => x.carryOver).length,
    overdueRemaining: current.reduce((n, x) => n + (x.carryOver?.remaining || 0), 0),
  };
  return { department, ...ev.DEPARTMENT_META[department], asOfDay, summary: { ...summary, upcoming: upcoming.length }, targets: current, upcoming };
}

/* ── writes ──────────────────────────────────────────────────────────────── */

class TargetError extends Error { constructor(status, message) { super(message); this.status = status; } }

function validateBody(body) {
  const b = body || {};
  const department = String(b.department || "").trim();
  if (!DEPARTMENTS.includes(department)) throw new TargetError(400, "Choose a department.");
  const kind = String(b.kind || "").trim();
  if (!KINDS.includes(kind)) throw new TargetError(400, "Choose how the target is counted: per day, per hour, or a total by a date.");
  const pieces = Number(b.pieces);
  if (!Number.isFinite(pieces) || pieces < 1 || pieces !== Math.floor(pieces)) throw new TargetError(400, "Pieces must be a whole number above 0.");
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(b.from || "").trim(), to = String(b.to || from).trim();
  if (!DAY.test(from) || !DAY.test(to)) throw new TargetError(400, "Pick the first and last date (YYYY-MM-DD).");
  if (to < from) throw new TargetError(400, "The last date is before the first.");
  const CLOCK = /^\d{2}:\d{2}$/;
  const hoursFrom = String(b.hoursFrom || "").trim(), hoursTo = String(b.hoursTo || "").trim();
  if ((hoursFrom && !CLOCK.test(hoursFrom)) || (hoursTo && !CLOCK.test(hoursTo))) throw new TargetError(400, "Times are HH:MM.");
  if ((hoursFrom && !hoursTo) || (!hoursFrom && hoursTo)) throw new TargetError(400, "Give both the start and end time, or neither.");
  if (hoursFrom && hoursTo && hoursTo <= hoursFrom) throw new TargetError(400, "The end time must be after the start time.");
  if (kind === "per_hour" && !hoursFrom) throw new TargetError(400, "A per-hour target needs the hours it applies to (e.g. 09:30 to 18:30).");
  let workingDays = Array.isArray(b.workingDays) ? b.workingDays.map(Number).filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
  workingDays = [...new Set(workingDays)].sort();
  if (!workingDays.length) throw new TargetError(400, "Choose at least one working day.");
  /* The shape (16 Oct 2026): a ramp over the first days, and the day split
     by hand. Both optional; both normalised here so a target can never carry
     a percentage or an hour the evaluator would have to guess about. */
  const ramp = curve.normaliseRamp(b.ramp);
  const hours = (Array.isArray(b.hours) ? b.hours : [])
    .filter((h) => h && CLOCK.test(String(h.from || "")) && CLOCK.test(String(h.to || "")) && Number(h.pieces) >= 0)
    .map((h) => ({ from: String(h.from), to: String(h.to), pieces: Math.round(Number(h.pieces)) }));
  for (const h of hours) {
    if (h.to <= h.from) throw new TargetError(400, `An hour of the day must end after it starts (${h.from}–${h.to}).`);
    if (hoursFrom && (h.from < hoursFrom || h.to > hoursTo)) throw new TargetError(400, `The hour ${h.from}–${h.to} is outside the target's window (${hoursFrom}–${hoursTo}).`);
  }
  /* A batch plan (the lays): dates and optional due times, whole garments. */
  const dayPlan = (Array.isArray(b.dayPlan) ? b.dayPlan : []).slice(0, 3000)
    .filter((x) => x && DAY.test(String(x.date || "")) && Number(x.pieces) > 0)
    .map((x) => ({ date: String(x.date), time: CLOCK.test(String(x.time || "")) ? String(x.time) : "", workOrderId: String(x.workOrderId || "").slice(0, 40), pieces: Math.round(Number(x.pieces)), label: String(x.label || "").slice(0, 40), layKey: String(x.layKey || "").slice(0, 60) }));
  const planSource = ["order", "department"].includes(b.planSource) ? b.planSource : "";
  const t = { department, kind, pieces, from, to, hoursFrom, hoursTo, workingDays, ramp, hours, cap: null, dayPlan, planSource, note: String(b.note || "").trim().slice(0, 500) };
  if (dayPlan.length) {
    /* A batch plan is a total delivered in batches: its quantity, first and
       last day are the batches', and a ramp has nothing to shape. */
    t.kind = "total"; t.ramp = [];
    t.pieces = dayPlan.reduce((nn, x) => nn + x.pieces, 0);
    t.from = dayPlan.map((x) => x.date).sort()[0];
    t.to = dayPlan.map((x) => x.date).sort().pop();
    t.workingDays = [0, 1, 2, 3, 4, 5, 6];
    return t;
  }
  if (ramp.length && kind === "total") throw new TargetError(400, "A ramp shapes a daily or hourly target. A total by a date spreads itself over its days — set it as a daily target to ramp it.");
  if (!ev.targetDays(t).length) throw new TargetError(400, "None of the chosen dates is a working day.");
  return t;
}

/* ── WHAT A TARGET MAY ASK (27 Sep 2026) ──────────────────────────────────────
 * One check, used by the form's preview AND by the save, so the form shows
 * the same refusal the server would give and never lets a bad target reach
 * the database. ERRORS block; WARNINGS are shown and allowed.
 *
 * Errors — a target that cannot be right:
 *   · the department has already done the whole order;
 *   · it asks for more pieces than the department has LEFT on the order
 *     (order quantity − what that department has already recorded);
 *   · its last date has passed, or its first date is before today.
 * Warnings — a target that may be right but needs a second look:
 *   · it ends after the customer's delivery date, or the order has none;
 *   · it replaces the department's current target on this order;
 *   · it leaves pieces with no target;
 *   · IE's standard says the department cannot do that many a day, or it is
 *     already busy on other orders over those dates.
 * "Left" is read from the same ledger the order page's pipeline shows, so
 * the number in the message is the number on the screen. */
const fmtDay = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

async function checkTarget(companyId, moId, body) {
  const errors = [], warnings = [];
  let t = null;
  try { t = validateBody(body); } catch (e) { if (e instanceof TargetError) return { t: null, errors: [e.message], warnings, facts: null }; throw e; }
  const label = ev.DEPARTMENT_META[t.department]?.label || t.department;
  const today = ev.dayOf(new Date());
  const orders = require("./control/orders.service");
  const [ctx, snap, standing] = await Promise.all([
    orderContext(companyId, moId),
    orders.snapshot(companyId, { moIds: [String(moId)] }),
    PpcOrderTarget.find({ companyId, manufacturingOrderId: oid(moId), department: t.department, status: "active" }).lean(),
  ]);
  if (!ctx) return { t, errors: ["The order could not be found."], warnings, facts: null };
  const row = orders.summariseOrders(snap).find((r) => r.moId === String(moId)) || null;

  /* ── WHAT IT IS ASKED AGAINST (16 Oct 2026) ────────────────────────────
     The whole order by default; a named mix of its work orders when the form
     sends them. Everything below — the quantity, what is already done, what
     is left, every refusal that quotes a figure — is that scope's, so asking
     Sewing for 400 on two of nineteen work orders is checked against those
     two and not against the order. */
  /* What each work order still has to go through this stage — read once from
     the department's book, so a per-work-order allocation can be refused, by
     name, when it asks for more than that work order has left. */
  const events = await doneEvents(t.department, ctx);
  const doneByWo = new Map();
  for (const e of events) if (e.woId) doneByWo.set(String(e.woId), (doneByWo.get(String(e.woId)) || 0) + (Number(e.qty) || 0));
  const leftByWo = new Map((ctx.workOrders || []).map((w) => [String(w.id), Math.max(0, (Number(w.quantity) || 0) - (doneByWo.get(String(w.id)) || 0))]));

  const sc = scopes.resolveScope(body, ctx, t.department, leftByWo);
  if (!sc.ok) return { t, errors: [sc.error], warnings, facts: null };
  const scope = sc.scope;
  const scoped = scope.kind === "work_orders";
  const allocated = scoped && Array.isArray(scope.allocations) && scope.allocations.length > 0;
  const scopeWords = scoped ? ` on ${scopes.describeScope(scope)}` : "";

  /* With per-work-order quantities, a TOTAL target asks for exactly their
     sum — the lines are the request — and the ceiling for a daily or hourly
     pace is that sum too. */
  if (allocated && t.kind === "total" && !(t.dayPlan && t.dayPlan.length)) t.pieces = scope.quantity;
  /* An allocated PACE stops at the allocation: "4 a day" on 18 garments asks
     4, 4, 4, 4, 2. The pace decides how fast; the work orders decide how
     many — so the two can no longer contradict each other (16 Oct 2026). */
  if (allocated && t.kind !== "total") t.cap = scope.quantity;

  const quantity = scoped ? (allocated ? scope.workOrderIds.reduce((n, id) => n + ((ctx.workOrders || []).find((w) => String(w.id) === String(id))?.quantity || 0), 0) : scope.quantity) : (row?.quantity || ctx.quantity);
  /* A plan by work order: every entry names a work order of the target, and
     each work order's entries add up to its quantity — the grid's rows ARE
     the allocations, so the two can never disagree. */
  const planErrors = [];
  if (t.dayPlan && t.dayPlan.some((x) => x.workOrderId)) {
    const byWo = new Map();
    for (const x of t.dayPlan) byWo.set(x.workOrderId, (byWo.get(x.workOrderId) || 0) + x.pieces);
    const allocs = allocated ? scope.allocations : [];
    const numberOf = (id) => (ctx.workOrders || []).find((w) => String(w.id) === String(id))?.number || id;
    for (const [id, q] of byWo) {
      const a = allocs.find((x) => String(x.workOrderId) === String(id));
      if (!id || !a) planErrors.push(`The plan schedules ${numberOf(id) || "an entry"} that is not among the target's work orders.`);
      else if (a.quantity !== q) planErrors.push(`${numberOf(id)}: the plan schedules ${q}, but ${a.quantity} is allocated.`);
    }
  }
  const done = scoped
    ? sum(scopes.scopedEvents(events, scope))
    : (row ? (row.departments.find((d) => d.department === t.department)?.done || 0) : sum(events));
  let left = allocated ? scope.quantity : Math.max(0, quantity - done);
  const days = ev.targetDays(t).length;
  const perDay = ev.expectedPerDay(t);
  /* With a ramp, what is being asked for is the sum of the shaped days — the
     figure the form shows and the one the refusals quote. */
  const shaped = t.kind === "total" ? t.pieces : curve.expectedTotal(perDay, t.ramp, days);
  const asked = t.cap ? Math.min(shaped, t.cap) : shaped;
  const delivery = ctx.deliveryDate ? ev.dayOf(ctx.deliveryDate) : null;
  /* Only a standing target that asks for the SAME work is replaced: two
     targets on different work orders are two live commitments. */
  const previous = (standing || []).find((p) => scopes.scopesOverlap(p.scope && p.scope.kind ? p.scope : { kind: "order" }, scope)) || null;

  /* The cut order plan, for cutting: checked against the allocations it is
     planned for, and its errors block the save like any other. */
  let cut = null;
  if (t.department === "cutting" && body?.cutPlan) {
    const rows = (allocated ? scope.allocations : (ctx.workOrders || []).map((w) => ({ workOrderId: w.id, quantity: leftByWo.get(String(w.id)) || 0 })))
      .map((a) => { const w = (ctx.workOrders || []).find((x) => String(x.id) === String(a.workOrderId)); return { colour: w?.colour || "", size: w?.size || "", quantity: a.quantity }; });
    cut = cutPlan.evaluate(body.cutPlan, rows);
  }

  /* Cutting cuts the allowance on top of the order: a lay plan built on the
     cut order plan may ask for the requirement INCLUDING the allowance — and,
     since a lay is whole plies, for what the plan cuts of the sizes the order
     REQUIRES (1,238 needed is 1,240 on the table). A size nobody ordered
     never raises the ceiling; a plan with errors gets the allowance only. */
  if (cut && t.dayPlan && t.dayPlan.length) {
    const ofRequired = cut.balance.filter((b) => !b.unrequired && b.withAllowance > 0).reduce((nn, b) => nn + Math.max(b.withAllowance, b.planned), 0);
    left = Math.max(left, cut.totals.withAllowance, cut.ok ? ofRequired : 0);
  }
  const facts = { moNumber: ctx.moNumber, department: t.department, label, scope, scopeLabel: scopes.describeScope(scope), orderQuantity: quantity, done, left, asked, days, perDay: Math.round(perDay * 10) / 10, from: t.from, to: t.to, deliveryDate: delivery, today, replaces: previous ? ev.describeTarget(previous) : null, leftByWo: Object.fromEntries(leftByWo), cutPlan: cut };

  /* ── THE MESSAGES (16 Oct 2026, owner: "too casual … non-professional") ──
     Each one states the condition, the figures it rests on, and the action
     that resolves it — in that order, in the register of a planning
     document, not a conversation. */
  if (!quantity) errors.push(`${ctx.moNumber || "This order"} has no quantity on record, so no target can be set against it.`);
  else if (left === 0) errors.push(`${label} has completed all ${quantity} garments on ${ctx.moNumber}${scopeWords}. No target is required.`);
  else if (asked > left) {
    const how = t.kind === "total" ? `${asked} garments` : `${asked} garments (${Math.round(perDay)} per day × ${days} working day${days === 1 ? "" : "s"})`;
    errors.push(allocated
      ? `Requested quantity exceeds the allocation. The daily pace amounts to ${how}; the work orders are allocated ${left} in total. Reduce the daily pace to ${Math.max(1, Math.floor(left / days))} or increase the allocation.`
      : `Requested quantity exceeds the balance. This target requests ${how}; ${label}'s balance on ${ctx.moNumber}${scopeWords} is ${left} (${done} of ${quantity} completed). Reduce the request to ${left} or fewer${t.kind === "total" ? "" : ` (e.g. ${Math.max(1, Math.floor(left / days))} per day)`}.`);
  }
  if (t.to < today) errors.push(`End date ${fmtDay(t.to)} is in the past. Select ${fmtDay(today)} or a later date.`);
  else if (t.from < today) errors.push(`Start date ${fmtDay(t.from)} is in the past. Select ${fmtDay(today)} or a later date.`);
  errors.push(...planErrors);
  if (cut) for (const pr of cut.problems) if (pr.level === "error") errors.push(`Cut plan: ${pr.text}`);

  if (!errors.length) {
    const dateWord = ctx.deliveryDateSource === "sales_wo" ? "the work-order deadline" : "the customer delivery date";
    if (!delivery) warnings.push(`No delivery date is recorded for ${ctx.moNumber}; this target cannot be checked against one.`);
    else if (t.to > delivery) warnings.push(`End date ${fmtDay(t.to)} falls after ${dateWord} (${fmtDay(delivery)}).`);
    if (previous) warnings.push(`Replaces the current ${label} target${previous.scope?.kind === "work_orders" ? ` on ${previous.scope.label}` : ""}: ${ev.describeTarget(previous)}`);
    if (!allocated && asked < left) warnings.push(`${left - asked} garments on ${ctx.moNumber}${scopeWords} remain without a ${label} target.`);
    if (allocated && t.kind !== "total" && shaped < scope.quantity) warnings.push(`At this pace ${shaped} of the ${scope.quantity} allocated are completed by ${fmtDay(t.to)}; ${scope.quantity - shaped} remain. Extend the last day or raise the pace.`);
    if (scoped) {
      const others = (standing || []).filter((p) => p !== previous);
      if (others.length) warnings.push(`${others.length} other ${label} target${others.length === 1 ? " remains" : "s remain"} in force on other work orders of ${ctx.moNumber}.`);
    }
    if (cut) for (const pr of cut.problems) if (pr.level === "warning") warnings.push(`Cut plan: ${pr.text}`);
    const assessment = await assess(companyId, moId, t);
    for (const w of assessment.warnings) if (w.level === "warn") warnings.push(w.text);
    return { t, errors, warnings, facts, assessment };
  }
  return { t, errors, warnings, facts, assessment: null };
}

/** The feasibility check for a proposed target: IE's standard + the department's other commitments. */
async function assess(companyId, moId, t) {
  const [std, others] = await Promise.all([
    standards.standardFor(companyId, t.department),
    PpcOrderTarget.find({ companyId, department: t.department, status: "active", manufacturingOrderId: { $ne: oid(moId) }, from: { $lte: t.to }, to: { $gte: t.from } }).lean(),
  ]);
  return ev.assessTarget(t, std, others);
}

/** What the form shows before saving: the sentence, the totals and the check. */
async function previewTarget(companyId, moId, body) {
  const c = await checkTarget(companyId, moId, body);
  if (!c.t) return { ok: false, errors: c.errors, warnings: [], description: "", days: 0, perDay: 0, total: 0, facts: null, assessment: null };
  const days = ev.targetDays(c.t);
  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings, facts: c.facts,
    description: ev.describeTarget(c.t), days: days.length, perDay: Math.round(ev.expectedPerDay(c.t)),
    total: c.t.kind === "total" ? c.t.pieces : Math.round(ev.expectedPerDay(c.t) * days.length), assessment: c.assessment };
}

async function setTarget(companyId, moId, body, actor) {
  const check = await checkTarget(companyId, moId, body);
  if (!check.t) throw new TargetError(400, check.errors[0] || "The target is not complete.");
  if (check.errors.length) { const e = new TargetError(409, check.errors.join(" ")); e.errors = check.errors; e.facts = check.facts; throw e; }
  const t = check.t;
  const ctx = await orderContext(companyId, moId);
  if (!ctx) throw new TargetError(404, "That order was not found.");
  const warnings = check.warnings;
  const assessment = check.assessment;

  const now = new Date();
  const lbw = check.facts?.leftByWo ? new Map(Object.entries(check.facts.leftByWo)) : null;
  const sc = scopes.resolveScope(body, ctx, t.department, lbw);
  if (!sc.ok) throw new TargetError(400, sc.error);
  const scope = sc.scope;

  /* A PROPOSAL (from an order page): stored, checked like any target, but
     not live — the department's plan is the gate. A newer proposal for the
     same order and department supersedes the older one; the live target is
     untouched until the department plan takes it in. */
  if (body?.propose === true) {
    const now = new Date();
    const doc = await PpcOrderTarget.create({
      companyId, manufacturingOrderId: oid(moId), moNumber: ctx.moNumber, customerName: ctx.customerName, orderQuantity: ctx.quantity,
      scope: {
        kind: scope.kind, workOrderIds: scope.kind === "work_orders" ? scope.workOrderIds.map(oid) : [],
        quantity: scope.quantity, count: scope.count, label: scope.label, detail: scope.detail || "",
        allocations: (scope.allocations || []).map((a) => ({ workOrderId: oid(a.workOrderId), quantity: a.quantity })),
      },
      ...t, planSource: "order", status: "proposed", assignedBy: actor, assignedAt: now, assessment,
    });
    await PpcOrderTarget.updateMany(
      { companyId, manufacturingOrderId: oid(moId), department: t.department, status: "proposed", _id: { $ne: doc._id } },
      { $set: { status: "replaced", replacedById: doc._id, endedAt: now, endedBy: actor, endReason: "A newer proposal replaced it" } },
    );
    return { target: doc.toObject(), description: ev.describeTarget(doc), proposed: true, replaced: null, warnings };
  }

  /* Replace the standing target that asks for the SAME work — the whole
     order, or an overlapping set of work orders. One on other work orders is
     a different commitment and is left alone (16 Oct 2026). */
  const standing = await PpcOrderTarget.find({ companyId, manufacturingOrderId: oid(moId), department: t.department, status: "active" });
  const previous = standing.find((p) => scopes.scopesOverlap(p.scope && p.scope.kind ? p.scope.toObject?.() || p.scope : { kind: "order" }, scope)) || null;

  const doc = await PpcOrderTarget.create({
    companyId, manufacturingOrderId: oid(moId), moNumber: ctx.moNumber, customerName: ctx.customerName, orderQuantity: ctx.quantity,
    scope: {
      kind: scope.kind, workOrderIds: scope.kind === "work_orders" ? scope.workOrderIds.map(oid) : [],
      quantity: scope.quantity, count: scope.count, label: scope.label, detail: scope.detail || "",
      allocations: (scope.allocations || []).map((a) => ({ workOrderId: oid(a.workOrderId), quantity: a.quantity })),
    },
    cutPlan: t.department === "cutting" && body?.cutPlan ? cutPlan.normalise(body.cutPlan) : null,
    ...t, assignedBy: actor, assignedAt: now, assessment,
  });
  if (previous) {
    previous.status = "replaced"; previous.replacedById = doc._id; previous.endedAt = now; previous.endedBy = actor; previous.endReason = "Replaced by a new target";
    await previous.save();
  }
  require("./control/orders.service").invalidateSnapshots(companyId);
  return { target: doc.toObject(), description: ev.describeTarget(doc), replaced: previous ? String(previous._id) : null, warnings };
}

async function cancelTarget(companyId, targetId, actor, reason = "") {
  const doc = await PpcOrderTarget.findOne({ _id: targetId, companyId });
  if (!doc) throw new TargetError(404, "That target was not found.");
  if (doc.status !== "active") throw new TargetError(409, "That target is no longer active.");
  doc.status = "cancelled"; doc.endedAt = new Date(); doc.endedBy = actor; doc.endReason = String(reason || "").trim().slice(0, 300);
  await doc.save();
  require("./control/orders.service").invalidateSnapshots(companyId);
  return { target: doc.toObject() };
}

/** The department plan turns a proposal down (it stays on record as declined). */
async function declineProposal(companyId, targetId, actor, reason = "") {
  if (!isId(targetId)) throw new TargetError(400, "Not a target id.");
  const doc = await PpcOrderTarget.findOneAndUpdate(
    { _id: oid(targetId), companyId, status: "proposed" },
    { $set: { status: "declined", endedAt: new Date(), endedBy: actor, endReason: String(reason || "").trim().slice(0, 300) || "Not taken into the department's plan" } },
    { new: true },
  ).lean();
  if (!doc) throw new TargetError(404, "That proposal is not waiting any more.");
  return { target: doc };
}

module.exports = { declineProposal, listOrders, orderDetail, departmentDay, previewTarget, setTarget, cancelTarget, checkTarget, validateBody, doneEvents, orderContext, TargetError, DEPARTMENTS, KINDS, isId, scopes };
