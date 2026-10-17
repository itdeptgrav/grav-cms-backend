// services/industrialEngineering/ieWorkOrderPlanning.service.js
//
// INDUSTRIAL ENGINEERING PLANS A WORK ORDER (16 Oct 2026, owner).
//
// Two things IE does to a work order, one or many at a time:
//
//   OPERATIONS  — the operation route the floor scans against
//                 (`WorkOrder.operations[]`: name, code, planned seconds).
//                 Typed, taken from the registered operations, from the
//                 style's technical route, from IE's library, or COPIED from
//                 another work order. "Operation assign is the main thing."
//
//   LINE PLAN   — which sewing line of the floor (CanvasLayout.lines[]) the
//                 work order runs on and, slot by slot, which of its operations
//                 is done at that station, by the machine standing there (and
//                 optionally by whom). Stored ON the work order (`linePlan`) so
//                 PPC and any later department read it beside the operations.
//
//   PROCESS FLOW — (17 Oct 2026, owner: "the IE person will do the planning /
//                 set the flow … keep a canvas interface like Canva so the
//                 departments come in boxes and he can connect which is first,
//                 then what next") which production DEPARTMENTS the work
//                 order passes through and in what order: a node per
//                 department, an arrow per hand-over, resolved here into one
//                 `sequence` so PPC and every department read the order
//                 without walking the graph. Stored ON the work order
//                 (`processFlow`).
//
// All three writes take `workOrderIds[]` — the owner's shortcut: select several
// work orders of the order and plan them in one go. Each work order gets its
// OWN copy; nothing is shared by reference.
//
// Every work order is read through the SAME ownership bound the IE order
// pages use (`ieOrders.orderOwnershipBound`), so a work order this company
// cannot prove is "not found" here exactly as it is there.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("../storePurchase/errors");
/* Required lazily: the pure rules below are tested without a database, and
   these two pull the whole model graph in. */
const ieOrders = () => require("./ieOrders.service");
const photos = () => require("../manufacturing/workOrderPhoto");
const { displayWorkOrderNumber } = require("../manufacturing/workOrderNumber");
const variantText = (v) => photos().variantText(v);

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[a-f0-9]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const model = (name, path) => (mongoose.models[name] || require(path));
const WorkOrder = () => model("WorkOrder", "../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CanvasLayout = () => model("CanvasLayout", "../../models/CMS_Models/Manufacturing/Production/CanvasLayout");
const Machine = () => model("Machine", "../../models/CMS_Models/Inventory/Configurations/Machine");
const Operation = () => model("Operation", "../../models/CMS_Models/Inventory/Configurations/Operation");
const Employee = () => model("Employee", "../../models/Employee");

const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  WORK_ORDER_CLOSED: "WORK_ORDER_CLOSED",
});

/* A work order that is finished or cancelled keeps its route and plan as
   history; IE changes neither. */
const CLOSED = new Set(["completed", "cancelled", "forwarded"]);
const MAX_OPERATIONS = 400;
const MAX_WORK_ORDERS = 200;
const SIDES = new Set(["L", "R"]);

/* ── THE PRODUCTION DEPARTMENTS A FLOW IS DRAWN FROM (17 Oct 2026) ─────────
   The owner's list, in the order a garment most often meets them. `key` is
   what a flow stores; `label` is what every screen prints. A flow may also
   carry a `custom` node IE names itself (a subcontractor, a special
   process) — the catalogue is the vocabulary, not a fence. The frontend
   mirrors this list in components/industrialEngineering/orders/processFlow.mjs;
   keep the two the same. */
const DEPARTMENTS = Object.freeze([
  { key: "cutting", label: "Cutting", short: "CUT" },
  { key: "embroidery", label: "Embroidery", short: "EMB" },
  { key: "printing", label: "Printing", short: "PRT" },
  { key: "sewing", label: "Sewing", short: "SEW" },
  { key: "qc1", label: "QC 1 (inline)", short: "QC1" },
  { key: "trimming", label: "Trimming", short: "TRM" },
  { key: "washing", label: "Washing", short: "WSH" },
  { key: "ironing", label: "Ironing", short: "IRN" },
  { key: "qc2", label: "QC 2 (final)", short: "QC2" },
  { key: "ll", label: "LL", short: "LL" },
  { key: "packaging", label: "Packaging", short: "PKG" },
  { key: "dispatch", label: "Dispatch", short: "DSP" },
]);
const DEPARTMENT_BY_KEY = new Map(DEPARTMENTS.map((d) => [d.key, d]));
const MAX_FLOW_NODES = 40;

const notFound = () => fail(CODES.NOT_FOUND, "That work order was not found.");
const invalid = (message, details) => fail(CODES.VALIDATION, message, details);

const PLAN_PROJECTION = [
  "_id workOrderNumber status planningState priority quantity",
  "stockItemId stockItemName stockItemReference variantId variantAttributes",
  "customerRequestId customerName createdAt updatedAt",
  "operations operationsPlan linePlan processFlow",
].join(" ");

/* ═══ READS ═══════════════════════════════════════════════════════════════ */

async function boundFor(ctx) {
  const bound = await ieOrders().orderOwnershipBound(ctx.companyId);
  if (!bound) throw notFound();
  return bound;
}

function idsOf(list) {
  const ids = [...new Set((Array.isArray(list) ? list : [list]).map(str).filter(isId))];
  if (!ids.length) throw invalid("Name at least one work order.");
  if (ids.length > MAX_WORK_ORDERS) throw invalid(`At most ${MAX_WORK_ORDERS} work orders at once.`);
  return ids;
}

/** The bound work orders among `ids`, in the order asked. Missing → not found. */
async function loadBound(ctx, ids, { select = PLAN_PROJECTION } = {}) {
  const bound = await boundFor(ctx);
  const rows = await WorkOrder().find({ $and: [{ _id: { $in: ids.map(oid) } }, bound.clause] })
    .select(select).lean();
  const byId = new Map(rows.map((r) => [str(r._id), r]));
  if (ids.some((id) => !byId.has(id))) throw notFound();
  return ids.map((id) => byId.get(id));
}

const operationRow = (op, i) => ({
  operationId: op?._id ? str(op._id) : null,
  sequence: i + 1,
  name: str(op?.operationType),
  code: str(op?.operationCode),
  seconds: Number(op?.plannedTimeSeconds) || 0,
  status: str(op?.status) || "pending",
  notes: str(op?.notes),
});

function operationsView(wo) {
  const ops = Array.isArray(wo?.operations) ? wo.operations : [];
  const totalSeconds = ops.reduce((s, op) => s + (Number(op.plannedTimeSeconds) || 0), 0);
  return {
    count: ops.length,
    totalSeconds,
    samMinutes: ops.length ? Math.round((totalSeconds / 60) * 100) / 100 : null,
    rows: ops.map(operationRow),
    plan: wo?.operationsPlan ? {
      source: str(wo.operationsPlan.source),
      copiedFromWorkOrderId: wo.operationsPlan.copiedFromWorkOrderId ? str(wo.operationsPlan.copiedFromWorkOrderId) : null,
      copiedFromWorkOrderNumber: str(wo.operationsPlan.copiedFromWorkOrderNumber),
      updatedAt: wo.operationsPlan.updatedAt || null,
      updatedBy: wo.operationsPlan.updatedBy?.name || "",
      version: wo.operationsPlan.version || 1,
    } : null,
  };
}

function linePlanView(wo) {
  const p = wo?.linePlan;
  if (!p || !p.lineId) return null;
  return {
    lineId: str(p.lineId),
    lineName: str(p.lineName),
    slotsPerSide: p.slotsPerSide || 13,
    pitch: p.pitch || 175,
    tableWidth: p.tableWidth || 120,
    stations: (p.stations || []).map((s) => ({
      side: s.side, index: s.index, item: s.item || "empty",
      machineId: s.machineId ? str(s.machineId) : null, machineName: str(s.machineName), machineType: str(s.machineType),
      operationId: s.operationId ? str(s.operationId) : null, operationCode: str(s.operationCode), operationType: str(s.operationType),
      plannedTimeSeconds: Number(s.plannedTimeSeconds) || 0,
      operatorId: str(s.operatorId), operatorName: str(s.operatorName), notes: str(s.notes),
    })),
    summary: {
      stations: p.summary?.stations || 0,
      operationsPlaced: p.summary?.operationsPlaced || 0,
      operationsTotal: p.summary?.operationsTotal || 0,
      samMinutes: p.summary?.samMinutes || 0,
    },
    notes: str(p.notes),
    copiedFromWorkOrderId: p.copiedFromWorkOrderId ? str(p.copiedFromWorkOrderId) : null,
    copiedFromWorkOrderNumber: str(p.copiedFromWorkOrderNumber),
    version: p.version || 1,
    plannedAt: p.plannedAt || null,
    plannedBy: p.plannedBy?.name || "",
  };
}

/** The label a department key prints as — the catalogue's, or the node's own. */
const departmentLabel = (node) => str(node?.label) || DEPARTMENT_BY_KEY.get(str(node?.department))?.label || str(node?.department) || str(node?.key);

function processFlowView(wo) {
  const f = wo?.processFlow;
  if (!f || !Array.isArray(f.nodes) || !f.nodes.length) return null;
  const nodes = f.nodes.map((n) => ({
    key: str(n.key), department: str(n.department), label: departmentLabel(n),
    x: Number(n.x) || 0, y: Number(n.y) || 0, notes: str(n.notes), optional: Boolean(n.optional),
  }));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const sequence = (f.sequence || []).map(str).filter((k) => byKey.has(k));
  return {
    nodes,
    edges: (f.edges || []).map((e) => ({ from: str(e.from), to: str(e.to) })),
    sequence,
    /* the sequence in words — what a row chip and PPC print */
    sequenceLabels: sequence.map((k) => byKey.get(k).label),
    summary: {
      steps: f.summary?.steps || nodes.length,
      startAt: str(f.summary?.startAt) || (sequence[0] ? byKey.get(sequence[0]).label : ""),
      endAt: str(f.summary?.endAt) || (sequence.length ? byKey.get(sequence[sequence.length - 1]).label : ""),
    },
    notes: str(f.notes),
    copiedFromWorkOrderId: f.copiedFromWorkOrderId ? str(f.copiedFromWorkOrderId) : null,
    copiedFromWorkOrderNumber: str(f.copiedFromWorkOrderNumber),
    version: f.version || 1,
    plannedAt: f.plannedAt || null,
    plannedBy: f.plannedBy?.name || "",
  };
}

/** One work order as IE's planning screens read it. */
async function workOrderView(wo, { photo = null, variant = null } = {}) {
  return {
    workOrderId: str(wo._id),
    reference: displayWorkOrderNumber(wo),
    status: str(wo.status),
    priority: str(wo.priority),
    quantity: wo.quantity == null ? null : Number(wo.quantity),
    product: { id: wo.stockItemId ? str(wo.stockItemId) : null, name: str(wo.stockItemName), reference: str(wo.stockItemReference), photo },
    variant: variant ? variantText(variant) : null,
    variantAttributes: variant?.attributes || wo.variantAttributes || [],
    customerName: str(wo.customerName),
    closed: CLOSED.has(str(wo.status)),
    operations: operationsView(wo),
    linePlan: linePlanView(wo),
    processFlow: processFlowView(wo),
  };
}

async function decorate(rows) {
  const { resolvePhotos, resolveVariantAttributes } = photos();
  const [pics, variants] = await Promise.all([resolvePhotos(rows), resolveVariantAttributes(rows)]);
  return Promise.all(rows.map((wo, i) => workOrderView(wo, { photo: pics[i], variant: variants[i] })));
}

/** GET /work-orders?ids=a,b,c — several work orders at once (the plan page). */
async function readWorkOrders(ctx, { ids } = {}) {
  const list = idsOf(ids);
  const rows = await loadBound(ctx, list);
  return { workOrders: await decorate(rows) };
}

/** GET /work-orders/:id */
async function readWorkOrder(ctx, { workOrderId } = {}) {
  const [wo] = await loadBound(ctx, idsOf([workOrderId]));
  const [view] = await decorate([wo]);
  return { workOrder: view };
}

/**
 * The floor as the line plan needs it: the sewing lines with what stands in
 * each slot (from CanvasLayout + the machine register). Read-only; the
 * supervisor's /canvas-layout route stays the writer of the floor itself.
 */
async function readFloor() {
  const layout = await CanvasLayout().findOne({ organizationId: "default" })
    .select("lines machinePositions version updatedAt").lean();
  const lines = Array.isArray(layout?.lines) ? layout.lines : [];
  const machineIds = [...new Set(lines.flatMap((l) => (l.slots || []).map((s) => s.machineId && str(s.machineId)).filter(Boolean)))];
  /* 17 Oct 2026: the machine's own code, serial, brand and model travel too —
     "the machine full name and all are not happening" was a station card that
     printed a type and nothing else. */
  const machines = machineIds.length
    ? await Machine().find({ _id: { $in: machineIds.map(oid) } }).select("_id name type machineId serialNumber brand model status").lean()
    : [];
  const byId = new Map(machines.map((m) => [str(m._id), m]));
  return {
    version: layout?.version || 0,
    updatedAt: layout?.updatedAt || null,
    lines: lines.map((l, i) => ({
      id: str(l.id) || `line-${i + 1}`,
      name: str(l.name) || `Line ${i + 1}`,
      slotsPerSide: l.slotsPerSide || 13,
      pitch: l.pitch || 175,
      tableWidth: l.tableWidth || 120,
      slots: (l.slots || []).map((s) => {
        const m = s.machineId ? byId.get(str(s.machineId)) : null;
        return {
          side: s.side, index: s.index, item: s.item || "machine",
          machineId: s.machineId ? str(s.machineId) : null,
          machineName: m ? str(m.name) : "", machineType: m ? str(m.type) : "",
          machineCode: m ? str(m.machineId) : "",
          serialNumber: m ? str(m.serialNumber) : "",
          brand: m ? str(m.brand) : "", model: m ? str(m.model) : "",
          machineStatus: m ? str(m.status) : "",
          inRegister: s.item === "table" ? null : Boolean(m),
        };
      }),
    })),
  };
}

/**
 * Work orders of this company that already carry a line plan or a route —
 * the "copy from another work order" picker. Most recent first, bounded.
 */
async function planSources(ctx, { q = "", what = "line-plan", limit = 40 } = {}) {
  const bound = await boundFor(ctx);
  const which = what === "operations" ? { "operations.0": { $exists: true } }
    : what === "process-flow" ? { "processFlow.nodes.0": { $exists: true } }
    : { "linePlan.lineId": { $exists: true, $ne: "" } };
  const rows = await WorkOrder().find({ $and: [bound.clause, which] })
    .select("_id workOrderNumber status stockItemName stockItemReference variantAttributes customerRequestId customerName quantity updatedAt operations.operationType operations.operationCode operations.plannedTimeSeconds linePlan.lineName linePlan.summary linePlan.plannedAt operationsPlan.updatedAt processFlow.nodes processFlow.sequence processFlow.summary processFlow.plannedAt")
    .sort({ updatedAt: -1 }).limit(Math.min(200, Math.max(1, Number(limit) || 40)) * 2).lean();
  const term = str(q).toLowerCase();
  const out = rows.map((wo) => {
    const flow = processFlowView(wo);
    return {
      workOrderId: str(wo._id),
      reference: displayWorkOrderNumber(wo),
      status: str(wo.status),
      product: { name: str(wo.stockItemName), reference: str(wo.stockItemReference) },
      variant: variantText({ attributes: wo.variantAttributes || [] }),
      customerName: str(wo.customerName),
      moId: wo.customerRequestId ? str(wo.customerRequestId) : null,
      quantity: wo.quantity ?? null,
      operations: { count: (wo.operations || []).length, samMinutes: operationsView(wo).samMinutes },
      linePlan: wo.linePlan?.lineName ? { lineName: str(wo.linePlan.lineName), stations: wo.linePlan.summary?.stations || 0, plannedAt: wo.linePlan.plannedAt || null } : null,
      processFlow: flow ? { steps: flow.summary.steps, sequenceLabels: flow.sequenceLabels, plannedAt: flow.plannedAt } : null,
      updatedAt: wo.updatedAt || null,
    };
  }).filter((r) => !term || [r.reference, r.product.name, r.product.reference, r.variant, r.customerName].some((v) => str(v).toLowerCase().includes(term)));
  return { rows: out.slice(0, Math.min(200, Math.max(1, Number(limit) || 40))) };
}

/** The registered operations, for the assign picker (name, code, SAM, machine type). */
async function registeredOperations({ q = "", limit = 500 } = {}) {
  const filter = {};
  const term = str(q);
  if (term) filter.$or = [{ name: { $regex: term, $options: "i" } }, { operationCode: { $regex: term, $options: "i" } }];
  const rows = await Operation().find(filter).select("_id name operationCode totalSam durationSeconds machineType").sort({ name: 1 }).limit(Math.min(1000, Number(limit) || 500)).lean();
  return {
    rows: rows.map((o) => ({
      id: str(o._id), name: str(o.name), code: str(o.operationCode),
      seconds: Number.isFinite(Number(o.durationSeconds)) ? Number(o.durationSeconds) : Math.round((Number(o.totalSam) || 0) * 60),
      samMinutes: Number(o.totalSam) || 0, machineType: str(o.machineType),
    })),
  };
}

/** Operators for a station, by name or badge. */
async function operators({ q = "", limit = 20 } = {}) {
  const term = str(q);
  if (!term) return { rows: [] };
  const rx = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const rows = await Employee().find({ $or: [{ name: rx }, { identityId: rx }, { biometricId: rx }, { employeeId: rx }] })
    .select("_id name identityId biometricId employeeId department designation").limit(Math.min(50, Number(limit) || 20)).lean();
  return {
    rows: rows.map((e) => ({
      id: str(e.identityId || e.biometricId || e.employeeId || e._id),
      name: str(e.name), badge: str(e.identityId || e.biometricId || e.employeeId),
      department: str(e.department), designation: str(e.designation),
    })),
  };
}

/* ═══ OPERATIONS ══════════════════════════════════════════════════════════ */

/** The operations as they will be stored — bounded, trimmed, named. */
function normaliseOperations(list) {
  if (!Array.isArray(list)) throw invalid("Send the operations as a list.");
  if (list.length > MAX_OPERATIONS) throw invalid(`At most ${MAX_OPERATIONS} operations on a work order.`);
  const out = [];
  list.forEach((op, i) => {
    const name = str(op?.operationType ?? op?.name);
    if (!name) throw invalid(`Operation ${i + 1} has no name.`, { index: i });
    const seconds = op?.plannedTimeSeconds ?? op?.seconds ?? (op?.samMinutes != null ? Number(op.samMinutes) * 60 : 0);
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) throw invalid(`Operation ${i + 1} (${name}) has an invalid time.`, { index: i });
    out.push({
      operationType: name.slice(0, 120),
      operationCode: str(op?.operationCode ?? op?.code).slice(0, 40),
      plannedTimeSeconds: Math.round(n),
      status: "pending",
      notes: str(op?.notes).slice(0, 500),
    });
  });
  return out;
}

const stamp = (actor, extra = {}) => ({
  updatedAt: new Date(),
  updatedBy: { userId: str(actor?.id), name: str(actor?.name), email: str(actor?.email) },
  ...extra,
});

/**
 * POST /work-orders/operations  { workOrderIds, operations, mode, source }
 *
 * `mode` "replace" (default) sets the route; "append" adds after what is
 * there. A closed work order is skipped and named, never changed. Every
 * work order gets its own copy of the list.
 */
async function setOperations(ctx, { workOrderIds, operations, mode = "replace", source = "ie-typed", copiedFrom = null } = {}, actor) {
  const ids = idsOf(workOrderIds);
  const ops = normaliseOperations(operations);
  if (mode !== "replace" && mode !== "append") throw invalid("mode must be replace or append.");
  const rows = await loadBound(ctx, ids, { select: "_id workOrderNumber status operations operationsPlan" });
  const results = [];
  for (const wo of rows) {
    if (CLOSED.has(str(wo.status))) {
      results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "skipped", reason: `Work order is ${wo.status}.` });
      continue;
    }
    const next = mode === "append" ? [...(wo.operations || []).map((o) => ({ ...o })), ...ops] : ops;
    if (next.length > MAX_OPERATIONS) throw invalid(`${displayWorkOrderNumber(wo)} would carry more than ${MAX_OPERATIONS} operations.`);
    const version = (wo.operationsPlan?.version || 0) + 1;
    await WorkOrder().updateOne({ _id: wo._id }, {
      $set: {
        operations: next,
        operationsPlan: stamp(actor, {
          source: str(source).slice(0, 40) || "ie-typed",
          copiedFromWorkOrderId: copiedFrom?.workOrderId && isId(copiedFrom.workOrderId) ? oid(copiedFrom.workOrderId) : null,
          copiedFromWorkOrderNumber: str(copiedFrom?.reference).slice(0, 60),
          version,
        }),
      },
    });
    results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "saved", operations: next.length, version });
  }
  return { results, saved: results.filter((r) => r.status === "saved").length, skipped: results.filter((r) => r.status === "skipped").length };
}

/** POST /work-orders/operations/copy { fromWorkOrderId, workOrderIds, mode } */
async function copyOperations(ctx, { fromWorkOrderId, workOrderIds, mode = "replace" } = {}, actor) {
  const [from] = await loadBound(ctx, idsOf([fromWorkOrderId]), { select: "_id workOrderNumber operations" });
  const ops = (from.operations || []).map((o) => ({ operationType: o.operationType, operationCode: o.operationCode, plannedTimeSeconds: o.plannedTimeSeconds, notes: o.notes }));
  if (!ops.length) throw invalid(`${displayWorkOrderNumber(from)} has no operations to copy.`);
  const targets = idsOf(workOrderIds).filter((id) => id !== str(from._id));
  if (!targets.length) throw invalid("Choose a work order other than the one being copied.");
  const out = await setOperations(ctx, {
    workOrderIds: targets, operations: ops, mode, source: "ie-copy",
    copiedFrom: { workOrderId: str(from._id), reference: displayWorkOrderNumber(from) },
  }, actor);
  return { ...out, from: { workOrderId: str(from._id), reference: displayWorkOrderNumber(from), operations: ops.length } };
}

/* ═══ LINE PLAN ═══════════════════════════════════════════════════════════ */

/**
 * The plan as it will be stored for ONE work order: the line's shape from the
 * body (bounded), each station's machine as the body says the floor had it,
 * and each station's operation RESOLVED against that work order's own
 * operations — by operation id first, then by code, then by name — so a plan
 * applied to several work orders names each one's own operation row.
 */
function planFor(body, wo, { copiedFrom = null } = {}) {
  const lineId = str(body?.lineId);
  if (!lineId) throw invalid("Choose a sewing line.");
  const slotsPerSide = Math.min(40, Math.max(1, Math.round(Number(body?.slotsPerSide) || 13)));
  const ops = Array.isArray(wo.operations) ? wo.operations : [];
  const byId = new Map(ops.map((o) => [str(o._id), o]));
  const byCode = new Map(ops.filter((o) => str(o.operationCode)).map((o) => [str(o.operationCode).toLowerCase(), o]));
  const byName = new Map(ops.map((o) => [str(o.operationType).toLowerCase(), o]));
  const seen = new Set();
  const stations = [];
  const list = Array.isArray(body?.stations) ? body.stations : [];
  if (list.length > slotsPerSide * 2) throw invalid("More stations than the line has slots.");
  for (const s of list) {
    const side = str(s?.side).toUpperCase();
    const index = Math.round(Number(s?.index));
    if (!SIDES.has(side) || !Number.isFinite(index) || index < 1 || index > slotsPerSide) throw invalid(`Station ${side}${index} is not on the line.`);
    const key = `${side}${index}`;
    if (seen.has(key)) throw invalid(`Station ${key} is listed twice.`);
    seen.add(key);
    let op = null;
    if (s?.operationId && byId.has(str(s.operationId))) op = byId.get(str(s.operationId));
    else if (str(s?.operationCode) && byCode.has(str(s.operationCode).toLowerCase())) op = byCode.get(str(s.operationCode).toLowerCase());
    else if (str(s?.operationType) && byName.has(str(s.operationType).toLowerCase())) op = byName.get(str(s.operationType).toLowerCase());
    const named = str(s?.operationType) || str(s?.operationCode);
    const item = s?.item === "table" ? "table" : s?.item === "machine" || s?.machineId ? "machine" : "empty";
    stations.push({
      side, index, item,
      machineId: s?.machineId && isId(s.machineId) ? oid(s.machineId) : null,
      machineName: str(s?.machineName).slice(0, 80),
      machineType: str(s?.machineType).slice(0, 60),
      operationId: op ? op._id : null,
      /* an operation the work order does not have is kept BY NAME, flagged
         by a null operationId, so the screen can say "not on this work order" */
      operationCode: op ? str(op.operationCode) : str(s?.operationCode).slice(0, 40),
      operationType: op ? str(op.operationType) : named.slice(0, 120),
      plannedTimeSeconds: op ? (Number(op.plannedTimeSeconds) || 0) : (Number(s?.plannedTimeSeconds) || 0),
      operatorId: str(s?.operatorId).slice(0, 40),
      operatorName: str(s?.operatorName).slice(0, 80),
      notes: str(s?.notes).slice(0, 300),
    });
  }
  stations.sort((a, b) => (a.side === b.side ? a.index - b.index : a.side === "L" ? -1 : 1));
  const placedIds = new Set(stations.filter((s) => s.operationId).map((s) => str(s.operationId)));
  const samSeconds = stations.reduce((n, s) => n + (s.operationType ? s.plannedTimeSeconds : 0), 0);
  return {
    lineId, lineName: str(body?.lineName).slice(0, 60), slotsPerSide,
    pitch: Number(body?.pitch) || 175, tableWidth: Number(body?.tableWidth) || 120,
    stations,
    summary: {
      stations: stations.filter((s) => s.operationType).length,
      operationsPlaced: placedIds.size,
      operationsTotal: ops.length,
      samMinutes: Math.round((samSeconds / 60) * 100) / 100,
    },
    notes: str(body?.notes).slice(0, 1000),
    copiedFromWorkOrderId: copiedFrom?.workOrderId && isId(copiedFrom.workOrderId) ? oid(copiedFrom.workOrderId) : null,
    copiedFromWorkOrderNumber: str(copiedFrom?.reference).slice(0, 60),
  };
}

/** POST /work-orders/line-plan { workOrderIds, plan } */
async function saveLinePlan(ctx, { workOrderIds, plan, copiedFrom = null } = {}, actor) {
  const ids = idsOf(workOrderIds);
  const rows = await loadBound(ctx, ids, { select: "_id workOrderNumber status operations linePlan" });
  const results = [];
  for (const wo of rows) {
    if (CLOSED.has(str(wo.status))) {
      results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "skipped", reason: `Work order is ${wo.status}.` });
      continue;
    }
    const next = planFor(plan, wo, { copiedFrom });
    const version = (wo.linePlan?.version || 0) + 1;
    await WorkOrder().updateOne({ _id: wo._id }, {
      $set: {
        linePlan: {
          ...next, version, plannedAt: new Date(),
          plannedBy: { userId: str(actor?.id), name: str(actor?.name), email: str(actor?.email) },
        },
      },
    });
    const unknown = next.stations.filter((s) => s.operationType && !s.operationId).map((s) => s.operationType);
    results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "saved", version, summary: next.summary, notOnWorkOrder: unknown });
  }
  return { results, saved: results.filter((r) => r.status === "saved").length, skipped: results.filter((r) => r.status === "skipped").length };
}

/** POST /work-orders/line-plan/copy { fromWorkOrderId, workOrderIds } */
async function copyLinePlan(ctx, { fromWorkOrderId, workOrderIds } = {}, actor) {
  const [from] = await loadBound(ctx, idsOf([fromWorkOrderId]), { select: "_id workOrderNumber linePlan" });
  const plan = linePlanView(from);
  if (!plan) throw invalid(`${displayWorkOrderNumber(from)} has no line plan to copy.`);
  const targets = idsOf(workOrderIds).filter((id) => id !== str(from._id));
  if (!targets.length) throw invalid("Choose a work order other than the one being copied.");
  const out = await saveLinePlan(ctx, { workOrderIds: targets, plan, copiedFrom: { workOrderId: str(from._id), reference: displayWorkOrderNumber(from) } }, actor);
  return { ...out, from: { workOrderId: str(from._id), reference: displayWorkOrderNumber(from), lineName: plan.lineName } };
}

/** POST /work-orders/line-plan/clear */
async function clearLinePlan(ctx, { workOrderId } = {}) {
  const [wo] = await loadBound(ctx, idsOf([workOrderId]), { select: "_id workOrderNumber status linePlan" });
  if (CLOSED.has(str(wo.status))) throw fail(CODES.WORK_ORDER_CLOSED, `Work order is ${wo.status}; its plan is history.`);
  await WorkOrder().updateOne({ _id: wo._id }, { $unset: { linePlan: 1 } });
  return { workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), cleared: Boolean(wo.linePlan) };
}

/* ═══ PROCESS FLOW ════════════════════════════════════════════════════════ */

/**
 * The order the departments are passed through, from the arrows: Kahn's
 * topological sort, ties broken by the node's x position then its listed
 * order so the sequence reads left to right as the canvas was drawn. Returns
 * null when the arrows form a cycle (a garment cannot come back to a
 * department it left on this drawing).
 */
function sequenceOf(nodes, edges) {
  const order = new Map(nodes.map((n, i) => [n.key, i]));
  const indeg = new Map(nodes.map((n) => [n.key, 0]));
  const next = new Map(nodes.map((n) => [n.key, []]));
  for (const e of edges) { indeg.set(e.to, indeg.get(e.to) + 1); next.get(e.from).push(e.to); }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const rank = (k) => [Number(byKey.get(k).x) || 0, order.get(k)];
  const pick = (list) => list.sort((a, b) => { const [ax, ai] = rank(a), [bx, bi] = rank(b); return ax - bx || ai - bi; }).shift();
  const ready = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key);
  const out = [];
  while (ready.length) {
    const k = pick(ready);
    out.push(k);
    for (const t of next.get(k)) { indeg.set(t, indeg.get(t) - 1); if (indeg.get(t) === 0) ready.push(t); }
  }
  return out.length === nodes.length ? out : null;
}

/**
 * The flow as it will be stored: bounded, keys unique, every arrow between
 * nodes that exist, no self-arrow, no duplicate arrow, no cycle; the
 * sequence resolved. A flow with one department and no arrows is allowed (a
 * work order that only passes Packaging, say); an empty one is not.
 */
function flowFor(body, { copiedFrom = null } = {}) {
  const list = Array.isArray(body?.nodes) ? body.nodes : [];
  if (!list.length) throw invalid("Put at least one department on the flow.");
  if (list.length > MAX_FLOW_NODES) throw invalid(`At most ${MAX_FLOW_NODES} departments on a flow.`);
  const keyOf = (v) => str(v).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40);
  const seen = new Set();
  const nodes = list.map((n, i) => {
    const key = keyOf(n?.key);
    if (!key) throw invalid(`Department ${i + 1} has no key.`, { index: i });
    if (seen.has(key)) throw invalid(`Department "${key}" is on the flow twice.`, { index: i });
    seen.add(key);
    const department = str(n?.department).toLowerCase().slice(0, 40) || (DEPARTMENT_BY_KEY.has(key) ? key : "custom");
    const known = DEPARTMENT_BY_KEY.get(department);
    const label = str(n?.label).slice(0, 60) || known?.label || "";
    if (!known && !label) throw invalid(`Department ${i + 1} is not in the catalogue and has no label.`, { index: i });
    return {
      key, department: known ? department : "custom", label: label || known.label,
      x: Math.round(Number(n?.x) || 0), y: Math.round(Number(n?.y) || 0),
      notes: str(n?.notes).slice(0, 300), optional: Boolean(n?.optional),
    };
  });
  const edgeList = Array.isArray(body?.edges) ? body.edges : [];
  const pairs = new Set();
  const edges = [];
  for (const e of edgeList) {
    const from = keyOf(e?.from); const to = keyOf(e?.to);
    if (!seen.has(from) || !seen.has(to)) throw invalid(`An arrow points at a department that is not on the flow (${from || "?"} → ${to || "?"}).`);
    if (from === to) throw invalid(`${from} cannot hand over to itself.`);
    const k = `${from}>${to}`;
    if (pairs.has(k)) continue; // the same arrow drawn twice is one arrow
    pairs.add(k);
    edges.push({ from, to });
  }
  const sequence = sequenceOf(nodes, edges);
  if (!sequence) throw invalid("The arrows go round in a circle. A flow must run one way: remove the arrow that comes back.");
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return {
    nodes, edges, sequence,
    summary: {
      steps: nodes.length,
      startAt: byKey.get(sequence[0]).label,
      endAt: byKey.get(sequence[sequence.length - 1]).label,
    },
    notes: str(body?.notes).slice(0, 1000),
    copiedFromWorkOrderId: copiedFrom?.workOrderId && isId(copiedFrom.workOrderId) ? oid(copiedFrom.workOrderId) : null,
    copiedFromWorkOrderNumber: str(copiedFrom?.reference).slice(0, 60),
  };
}

/** POST /work-orders/process-flow { workOrderIds, flow } */
async function saveProcessFlow(ctx, { workOrderIds, flow, copiedFrom = null } = {}, actor) {
  const ids = idsOf(workOrderIds);
  const next = flowFor(flow, { copiedFrom }); // once: the same drawing goes on every work order
  const rows = await loadBound(ctx, ids, { select: "_id workOrderNumber status processFlow" });
  const results = [];
  for (const wo of rows) {
    if (CLOSED.has(str(wo.status))) {
      results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "skipped", reason: `Work order is ${wo.status}.` });
      continue;
    }
    const version = (wo.processFlow?.version || 0) + 1;
    await WorkOrder().updateOne({ _id: wo._id }, {
      $set: {
        processFlow: {
          ...next, version, plannedAt: new Date(),
          plannedBy: { userId: str(actor?.id), name: str(actor?.name), email: str(actor?.email) },
        },
      },
    });
    results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "saved", version, summary: next.summary, sequence: next.sequence });
  }
  return { results, saved: results.filter((r) => r.status === "saved").length, skipped: results.filter((r) => r.status === "skipped").length };
}

/** POST /work-orders/process-flow/copy { fromWorkOrderId, workOrderIds } */
async function copyProcessFlow(ctx, { fromWorkOrderId, workOrderIds } = {}, actor) {
  const [from] = await loadBound(ctx, idsOf([fromWorkOrderId]), { select: "_id workOrderNumber processFlow" });
  const flow = processFlowView(from);
  if (!flow) throw invalid(`${displayWorkOrderNumber(from)} has no process flow to copy.`);
  const targets = idsOf(workOrderIds).filter((id) => id !== str(from._id));
  if (!targets.length) throw invalid("Choose a work order other than the one being copied.");
  const out = await saveProcessFlow(ctx, { workOrderIds: targets, flow, copiedFrom: { workOrderId: str(from._id), reference: displayWorkOrderNumber(from) } }, actor);
  return { ...out, from: { workOrderId: str(from._id), reference: displayWorkOrderNumber(from), steps: flow.summary.steps } };
}

/** POST /work-orders/process-flow/clear { workOrderIds } — one or many */
async function clearProcessFlow(ctx, { workOrderIds, workOrderId } = {}) {
  const ids = idsOf(workOrderIds || workOrderId);
  const rows = await loadBound(ctx, ids, { select: "_id workOrderNumber status processFlow" });
  const results = [];
  for (const wo of rows) {
    if (CLOSED.has(str(wo.status))) {
      results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "skipped", reason: `Work order is ${wo.status}; its flow is history.` });
      continue;
    }
    await WorkOrder().updateOne({ _id: wo._id }, { $unset: { processFlow: 1 } });
    results.push({ workOrderId: str(wo._id), reference: displayWorkOrderNumber(wo), status: "cleared", had: Boolean(wo.processFlow?.nodes?.length) });
  }
  return { results, cleared: results.filter((r) => r.status === "cleared").length, skipped: results.filter((r) => r.status === "skipped").length };
}

module.exports = {
  CODES, CLOSED, MAX_OPERATIONS, MAX_WORK_ORDERS, MAX_FLOW_NODES, DEPARTMENTS,
  readWorkOrders, readWorkOrder, readFloor, planSources, registeredOperations, operators,
  setOperations, copyOperations, saveLinePlan, copyLinePlan, clearLinePlan,
  saveProcessFlow, copyProcessFlow, clearProcessFlow,
  normaliseOperations, planFor, flowFor, sequenceOf, operationsView, linePlanView, processFlowView,
};
