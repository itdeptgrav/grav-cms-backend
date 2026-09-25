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
const standards = require("../industrialEngineering/departmentStandards.service");

const { DEPARTMENTS, KINDS } = PpcOrderTarget;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const FINISHING = new Set(["embroidery", "printing", "washing", "trimming", "ironing"]);

/* ── the order and its work orders ───────────────────────────────────────── */

async function orderContext(companyId, moId) {
  const [mo, wos] = await Promise.all([
    CustomerRequest.findById(moId).select("requestId customerInfo.name requestType status dueDate items").lean(),
    packagingAccess.findWorkOrders(companyId, { customerRequestId: oid(moId) }, "_id workOrderNumber quantity stockItemName status packagingRecords").lean(),
  ]);
  if (!mo) return null;
  const quantity = wos.reduce((n, w) => n + (w.quantity || 0), 0)
    || (mo.items || []).reduce((n, i) => n + (i.totalQuantity || 0), 0);
  return {
    mo, wos,
    moId: String(mo._id), moNumber: mo.requestId ? `MO-${mo.requestId}` : "", customerName: mo.customerInfo?.name || "",
    requestType: mo.requestType || "", status: mo.status || "", dueDate: mo.dueDate || null,
    quantity, workOrderIds: wos.map((w) => w._id), shortIds: new Set(wos.map((w) => String(w._id).slice(-8).toLowerCase())),
    workOrders: wos.map((w) => ({ id: String(w._id), number: displayWorkOrderNumber(w), product: w.stockItemName || "", quantity: w.quantity || 0 })),
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
 * Completion events for one department on one order: `[{ at, qty }]`.
 * `start`/`end` bound the read (null = all time).
 */
async function doneEvents(department, ctx, start = null, end = null) {
  const inRange = (field) => (start || end ? { [field]: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } } : {});
  const moId = oid(ctx.moId);
  if (FINISHING.has(department)) {
    const rows = await FinishingScan.find({ stage: department, manufacturingOrderId: moId, ...inRange("doneAt") }).select("doneAt").lean();
    return rows.map((r) => ({ at: r.doneAt, qty: 1 }));
  }
  if (department === "cutting") {
    if (!ctx.workOrderIds.length) return [];
    const woSet = new Set(ctx.workOrderIds.map(String));
    const docs = await CuttingMasterRecord.find({ "entries.woId": { $in: ctx.workOrderIds } }).select("entries.woId entries.quantityCut entries.timestamp").lean();
    const out = [];
    for (const d of docs) for (const e of d.entries || []) {
      if (!e.woId || !woSet.has(String(e.woId))) continue;
      const at = e.timestamp; if (start && at < start) continue; if (end && at >= end) continue;
      out.push({ at, qty: e.quantityCut || 0 });
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
    const seen = new Set(); const out = [];
    for (const d of docs) for (const s of d.scans || []) {
      const m = /^WO-([0-9a-f]{8})-\d+$/i.exec(String(s.barcodeId || "")); if (!m || !ctx.shortIds.has(m[1].toLowerCase())) continue;
      const key = s.barcodeId.toUpperCase(); if (seen.has(key)) continue; seen.add(key);
      const at = s.scannedAt || d.date; if (start && at < start) continue; if (end && at >= end) continue;
      out.push({ at, qty: 1 });
    }
    return out;
  }
  if (department === "qc") {
    const rows = await QCInspection.find({ manufacturingOrderId: moId, status: "passed", ...inRange("inspectedAt") }).select("barcodeId inspectedAt").sort({ inspectedAt: 1 }).lean();
    const seen = new Set(); const out = [];
    for (const r of rows) { if (seen.has(r.barcodeId)) continue; seen.add(r.barcodeId); out.push({ at: r.inspectedAt, qty: 1 }); }
    return out;
  }
  if (department === "packaging") {
    const out = [];
    for (const w of ctx.wos) for (const r of w.packagingRecords || []) {
      const at = r.packagedAt; if (!at) continue; if (start && at < start) continue; if (end && at >= end) continue;
      out.push({ at, qty: r.packagedQuantity || (r.unitNumbers || []).length });
    }
    return out;
  }
  if (department === "dispatch") {
    const rows = await DispatchChallan.find({ manufacturingOrderId: moId, ...inRange("createdAt") }).select("totalUnits createdAt").lean();
    return rows.map((r) => ({ at: r.createdAt, qty: r.totalUnits || 0 }));
  }
  return [];
}

const sum = (events) => events.reduce((n, e) => n + (Number(e.qty) || 0), 0);

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
  for (const department of DEPARTMENTS) {
    const events = await doneEvents(department, ctx);
    const doneOverall = sum(events);
    const mine = targets.filter((t) => t.department === department);
    const active = mine.find((t) => t.status === "active") || null;
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
      active: active ? { ...ev.evaluateTarget(active, events, asOfDay, { doneOverall, orderQuantity: ctx.quantity, standard: std }), assignedBy: active.assignedBy, assignedAt: active.assignedAt, description: ev.describeTarget(active), assessment: active.assessment || null } : null,
      past: mine.filter((t) => t.status !== "active").map((t) => ({ ...ev.evaluateTarget(t, events, asOfDay, { doneOverall, orderQuantity: ctx.quantity, standard: std }), endStatus: t.status, endReason: t.endReason, endedAt: t.endedAt, assignedBy: t.assignedBy, assignedAt: t.assignedAt, description: ev.describeTarget(t), assessment: t.assessment || null })),
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
  if (!DEPARTMENTS.includes(department)) return { targets: [] };
  const targets = await PpcOrderTarget.find({ department, status: "active", from: { $lte: asOfDay }, to: { $gte: ev.shiftDay(asOfDay, -7) } })
    .sort({ from: 1 }).lean();
  const out = [];
  const stdCache = new Map();
  for (const t of targets) {
    const ctx = await orderContext(t.companyId, t.manufacturingOrderId);
    if (!ctx) continue;
    const key = String(t.companyId);
    if (!stdCache.has(key)) stdCache.set(key, await standards.standardFor(t.companyId, department));
    const events = await doneEvents(department, ctx);
    const doneOverall = sum(events);
    out.push({
      ...ev.evaluateTarget(t, events, asOfDay, { doneOverall, orderQuantity: ctx.quantity, standard: stdCache.get(key) }),
      moId: ctx.moId, moNumber: ctx.moNumber, customerName: ctx.customerName, description: ev.describeTarget(t), assignedBy: t.assignedBy?.name || "",
    });
  }
  /* Today's targets first, then ones that just ended (still worth a glance). */
  out.sort((a, b) => (b.covers - a.covers) || a.from.localeCompare(b.from));
  const covering = out.filter((x) => x.covers);
  const summary = {
    targets: covering.length,
    expectedToday: covering.reduce((n, x) => n + (x.today?.expected || 0), 0),
    doneToday: covering.reduce((n, x) => n + (x.today?.done || 0), 0),
    behind: covering.filter((x) => x.status === "behind").length,
    achieved: covering.filter((x) => x.status === "achieved" || x.status === "exceeded").length,
  };
  return { department, ...ev.DEPARTMENT_META[department], asOfDay, summary, targets: out };
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
  const t = { department, kind, pieces, from, to, hoursFrom, hoursTo, workingDays, note: String(b.note || "").trim().slice(0, 500) };
  if (!ev.targetDays(t).length) throw new TargetError(400, "None of the chosen dates is a working day.");
  return t;
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
  const t = validateBody(body);
  const days = ev.targetDays(t);
  const assessment = await assess(companyId, moId, t);
  return { description: ev.describeTarget(t), days: days.length, perDay: Math.round(ev.expectedPerDay(t)),
    total: t.kind === "total" ? t.pieces : Math.round(ev.expectedPerDay(t) * days.length), assessment };
}

async function setTarget(companyId, moId, body, actor) {
  const t = validateBody(body);
  const ctx = await orderContext(companyId, moId);
  if (!ctx) throw new TargetError(404, "That order was not found.");
  if (!ctx.quantity) throw new TargetError(409, `${ctx.moNumber || "This order"} has no quantity yet — nothing to set a target against.`);
  const total = t.kind === "total" ? t.pieces : ev.expectedPerDay(t) * ev.targetDays(t).length;
  const warnings = [];
  if (total > ctx.quantity * 1.5) warnings.push(`This asks for ${Math.round(total)} pieces; the whole order is ${ctx.quantity}.`);
  const assessment = await assess(companyId, moId, t);
  for (const w of assessment.warnings) if (w.level === "warn") warnings.push(w.text);

  const now = new Date();
  const previous = await PpcOrderTarget.findOne({ companyId, manufacturingOrderId: oid(moId), department: t.department, status: "active" });
  const doc = await PpcOrderTarget.create({
    companyId, manufacturingOrderId: oid(moId), moNumber: ctx.moNumber, customerName: ctx.customerName, orderQuantity: ctx.quantity,
    ...t, assignedBy: actor, assignedAt: now, assessment,
  });
  if (previous) {
    previous.status = "replaced"; previous.replacedById = doc._id; previous.endedAt = now; previous.endedBy = actor; previous.endReason = "Replaced by a new target";
    await previous.save();
  }
  return { target: doc.toObject(), description: ev.describeTarget(doc), replaced: previous ? String(previous._id) : null, warnings };
}

async function cancelTarget(companyId, targetId, actor, reason = "") {
  const doc = await PpcOrderTarget.findOne({ _id: targetId, companyId });
  if (!doc) throw new TargetError(404, "That target was not found.");
  if (doc.status !== "active") throw new TargetError(409, "That target is no longer active.");
  doc.status = "cancelled"; doc.endedAt = new Date(); doc.endedBy = actor; doc.endReason = String(reason || "").trim().slice(0, 300);
  await doc.save();
  return { target: doc.toObject() };
}

module.exports = { listOrders, orderDetail, departmentDay, previewTarget, setTarget, cancelTarget, validateBody, doneEvents, orderContext, TargetError, DEPARTMENTS, KINDS, isId };
