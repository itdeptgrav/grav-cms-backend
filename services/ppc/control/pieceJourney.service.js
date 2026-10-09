"use strict";
// services/ppc/control/pieceJourney.service.js
//
// ONE PIECE, ITS WHOLE JOURNEY (4 Oct 2026, owner).
//
// PPC scans a garment piece's barcode and reads where it is: which stages are
// done, which remain, and — behind each stage — who recorded what and when.
// Production is operation by operation from the scanner events; QC is
// checkpoint by checkpoint with every inspection and its defects; finishing is
// each scan; packaging is the carton; dispatch is the challan.
//
// The PPC ledger (ledger.service.js) is counts-oriented — no units for cutting
// or dispatch, passed QC only, no operations — so this reads each department's
// OWN book for the one work order + unit, through the company-scoped work-order
// index that `resolveBarcode` already uses. Both label forms are read:
// `WO-<8 hex>-NNN` and `WO-<24 hex>-NNN`, padded or not, since every book stores
// the scan more or less verbatim.

const mongoose = require("mongoose");
const ledger = require("./ledger.service");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const FinishingScan = require("../../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const CuttingSeason = require("../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason");
const CuttingMasterRecord = require("../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const ProductionEvent = require("../../../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");
const ProductionCompletionScanRecord = require("../../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const QCInspection = require("../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const PackingCarton = require("../../../models/CMS_Models/Manufacturing/Packaging/PackingCarton");
const DispatchChallan = require("../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const Machine = require("../../../models/CMS_Models/Inventory/Configurations/Machine");
const Operation = require("../../../models/CMS_Models/Inventory/Configurations/Operation");
const { STAGES: FINISHING_STAGES } = require("../../manufacturing/finishingStages");
const qcStages = require("../../qcStages");
const qcOperators = require("../../qcOperators");

const { DEPARTMENTS, DEPARTMENT_META, CORE } = ledger;
const str = (v) => (v == null ? "" : String(v).trim());
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Every spelling a book may hold for this piece. */
function barcodeForms(woId, unit) {
  const full = String(woId).toLowerCase();
  const short = full.slice(-8);
  const units = [String(unit), String(unit).padStart(3, "0")];
  const out = new Set();
  for (const key of [short, full, short.toUpperCase(), full.toUpperCase()]) for (const u of units) out.add(`WO-${key}-${u}`);
  return [...out];
}
const keyForms = (woId) => { const full = String(woId).toLowerCase(); const short = full.slice(-8); return [short, full, short.toUpperCase(), full.toUpperCase()]; };

const personOf = (p) => (p && typeof p === "object" ? { name: str(p.name), id: str(p.userId || p.id || p.employeeId || ""), employeeId: str(p.employeeId) } : { name: str(p), id: "", employeeId: "" });

/** The unrecognised answer, in words the scanner's user can act on. */
function unrecognised(barcode, reason) {
  return { recognised: false, barcode: str(barcode), reason };
}

async function pieceJourney(companyId, barcode) {
  const raw = str(barcode);
  if (!raw) return unrecognised(raw, "Scan or type a piece barcode.");
  if (!/^WO-/i.test(raw)) return unrecognised(raw, "That is not a garment piece barcode. A piece reads WO-<work order>-<unit>, for example WO-A1B2C3D4-017.");
  /* ── RESOLVE THE ONE WORK ORDER, NOT THE WHOLE COMPANY ─────────────────
     `ledger.resolveBarcode` works off the company-wide index, which is the
     board's cost (every work order, populated). A scan is one piece: find
     its work order by id (24-hex label) or by the id's last eight characters
     (8-hex label), company-scoped through the same access the ledger uses,
     then index that one row. Cold: ~17 s → well under a second. */
  const m = /^WO-([0-9a-f]{8}|[0-9a-f]{24})-(\d+)$/i.exec(raw);
  if (!m) return unrecognised(raw, "That barcode is not in a form this factory prints. A piece reads WO-<work order>-<unit>, for example WO-A1B2C3D4-017.");
  const key = m[1].toLowerCase();
  const unit = Number(m[2]);
  if (!(unit > 0)) return unrecognised(raw, "The unit number on this barcode is not valid.");
  const packagingAccess = require("../../../routes/CMS_Routes/Manufacturing/Packaging/packagingAccess");
  const woFilter = key.length === 24
    ? { _id: oid(key) }
    : { $expr: { $eq: [{ $substrCP: [{ $toLower: { $toString: "$_id" } }, 16, 8] }, key] } };
  const candidates = await packagingAccess.findWorkOrders(companyId, woFilter, "_id").limit(2).lean();
  if (!candidates.length) return unrecognised(raw, "No work order of this company matches that barcode. Check the code, or the piece belongs to another company's order.");
  if (candidates.length > 1) return unrecognised(raw, "Two work orders share these eight characters — scan the full-length label on this piece.");
  const index = await ledger.woIndex(companyId, { woIds: [String(candidates[0]._id)] });
  const wo = index.byId.get(String(candidates[0]._id));
  if (!wo) return unrecognised(raw, "No work order of this company matches that barcode.");
  if (!(unit > 0)) return unrecognised(raw, "The unit number on this barcode is not valid.");
  const woId = oid(wo.id);
  const forms = barcodeForms(wo.id, unit);
  const [headers, woDoc] = await Promise.all([
    require("./orders.service").headersFor(wo.moId ? [wo.moId] : []),
    WorkOrder.findById(woId).select("operations packagingRecords dispatchRecords quantity cuttingStatus").lean(),
  ]);
  const header = wo.moId ? headers.get(String(wo.moId)) : null;

  const [season, cutEntries, finishing, events, completion, inspections, qcStageList, carton] = await Promise.all([
    CuttingSeason.findOne({ pieces: { $elemMatch: { workOrderId: woId, unitNumber: unit } } }).select("name status startedAt pieces.$").lean(),
    CuttingMasterRecord.find({ "entries.woId": woId }).select("employeeName entries date").lean(),
    FinishingScan.find({ workOrderId: woId, unitNumber: unit }).sort({ doneAt: 1 }).lean(),
    ProductionEvent.find({ workOrderKey: { $in: keyForms(wo.id) }, unitNumber: unit, type: "scan" }).sort({ scanTime: 1 }).lean(),
    ProductionCompletionScanRecord.aggregate([
      { $match: { "scans.barcodeId": { $in: forms } } },
      { $unwind: "$scans" },
      { $match: { "scans.barcodeId": { $in: forms } } },
      { $project: { _id: 0, at: "$scans.scannedAt", by: "$scans.scannedBy", day: "$date" } },
      { $sort: { at: 1 } },
    ]),
    QCInspection.find({ barcodeId: { $in: forms } }).sort({ inspectedAt: 1 }).lean(),
    qcStages.listStages().catch(() => []),
    PackingCarton.findOne({ lines: { $elemMatch: { workOrderId: woId, unitNumbers: unit } } }).lean(),
  ]);

  /* ── names for the production scans ─────────────────────────────────── */
  const machineIds = [...new Set(events.map((e) => String(e.machineId || "")).filter(Boolean))];
  const operatorIds = [...new Set(events.map((e) => str(e.operatorId)).filter(Boolean))];
  const [machines, operatorNames] = await Promise.all([
    machineIds.length ? Machine.find({ _id: { $in: machineIds } }).select("name machineType serialNumber").lean() : [],
    operatorIds.length ? qcOperators.resolveOperatorNames(operatorIds).catch(() => new Map()) : new Map(),
  ]);
  const machineById = new Map(machines.map((m) => [String(m._id), m]));
  const nameOf = (id) => {
    const key = str(id);
    if (!key) return "";
    if (operatorNames instanceof Map) return operatorNames.get(key) || "";
    return (operatorNames && operatorNames[key]) || "";
  };
  const opCodes = [...new Set(events.flatMap((e) => (e.activeOps || []).map(str)).filter(Boolean))];
  const woOps = new Map((woDoc?.operations || []).map((o) => [str(o.operationCode).toUpperCase(), o]));
  const missingCodes = opCodes.filter((c) => !woOps.has(c.toUpperCase()));
  const masters = missingCodes.length ? await Operation.find({ operationCode: { $in: missingCodes } }).select("name operationCode totalSam machineType").lean() : [];
  const masterByCode = new Map(masters.map((m) => [str(m.operationCode).toUpperCase(), m]));
  const opNameOf = (code) => {
    const k = str(code).toUpperCase();
    const w = woOps.get(k); if (w) return { name: str(w.operationType || w.type || w.name) || code, plannedSeconds: Number(w.plannedTimeSeconds) || null, sequence: Number(w.sequence) || null };
    const m = masterByCode.get(k); if (m) return { name: str(m.name) || code, plannedSeconds: m.totalSam != null ? Math.round(Number(m.totalSam) * 60) : null, sequence: null };
    return { name: code, plannedSeconds: null, sequence: null };
  };

  /* ── the stages, in production order ─────────────────────────────────── */
  const stages = [];
  const push = (s) => stages.push(s);

  // cutting
  {
    const piece = season?.pieces?.[0] || null;
    const entries = [];
    for (const rec of cutEntries) for (const e of rec.entries || []) {
      if (String(e.woId) !== String(woId)) continue;
      const a = Number(e.startUnit), b = Number(e.endUnit);
      const covers = Number.isFinite(a) && Number.isFinite(b) ? (unit >= Math.min(a, b) && unit <= Math.max(a, b)) : false;
      if (covers) entries.push({ at: e.timestamp || null, by: personOf(e.recordedBy || rec.employeeName), quantity: Number(e.quantityCut) || 0, startUnit: a, endUnit: b, day: rec.date || "" });
    }
    const done = Boolean(piece) || entries.length > 0;
    const at = piece?.scannedAt || entries[0]?.at || null;
    const by = piece ? personOf(piece.scannedBy) : (entries[0]?.by || null);
    push({
      department: "cutting", label: DEPARTMENT_META.cutting.label, doneLabel: "Cut", applicable: true, done, at, by,
      summary: done ? (piece ? `Scanned in season "${season.name}"` : `Cut in a batch of ${entries[0].quantity} (units ${entries[0].startUnit}–${entries[0].endUnit})`) : "",
      detail: { season: piece ? { name: str(season.name), status: str(season.status), at: piece.scannedAt || null, by: personOf(piece.scannedBy) } : null, entries },
    });
  }

  // finishing stages
  const finByStage = new Map();
  for (const f of finishing) { const k = str(f.stage); if (!finByStage.has(k)) finByStage.set(k, []); finByStage.get(k).push(f); }
  for (const dept of ["embroidery", "printing", "washing", "trimming", "ironing"]) {
    const rows = (finByStage.get(dept) || []).map((f) => ({ at: f.doneAt || null, recordedAt: f.recordedAt || null, by: personOf(f.doneBy), source: str(f.source), notes: str(f.notes) }));
    const done = rows.length > 0;
    push({
      department: dept, label: DEPARTMENT_META[dept].label, doneLabel: FINISHING_STAGES[dept]?.doneLabel || DEPARTMENT_META[dept].label,
      applicable: CORE.has(dept) || done, done, at: rows[0]?.at || null, by: rows[0]?.by || null,
      summary: done ? `${FINISHING_STAGES[dept]?.doneLabel || "Done"} by ${rows[0].by.name || "someone"}${rows[0].source ? ` · ${rows[0].source}` : ""}` : "",
      detail: { scans: rows },
    });
  }

  // production — operation by operation
  {
    const byOp = new Map();
    const unassigned = [];
    for (const e of events) {
      const m = machineById.get(String(e.machineId || ""));
      const scan = { at: e.scanTime || e.receivedAt || null, operatorId: str(e.operatorId), operator: nameOf(e.operatorId) || str(e.operatorName) || str(e.operatorId), machine: str(m?.name) || "", machineType: str(m?.machineType), device: str(e.deviceId), recovered: Boolean(e.timeRecovered) };
      const ops = (e.activeOps || []).map(str).filter(Boolean);
      if (!ops.length) { unassigned.push(scan); continue; }
      for (const code of ops) {
        if (!byOp.has(code)) byOp.set(code, { code, ...opNameOf(code), scans: [] });
        byOp.get(code).scans.push(scan);
      }
    }
    const operations = [...byOp.values()].map((o) => ({
      ...o, count: o.scans.length, firstAt: o.scans[0]?.at || null, lastAt: o.scans[o.scans.length - 1]?.at || null,
      operators: [...new Set(o.scans.map((s) => s.operator).filter(Boolean))], machines: [...new Set(o.scans.map((s) => s.machine).filter(Boolean))],
    })).sort((a, b) => (a.sequence ?? 999) - (b.sequence ?? 999) || (new Date(a.firstAt || 0) - new Date(b.firstAt || 0)));
    const completed = completion.map((c) => ({ at: c.at || null, by: personOf(c.by), day: c.day }));
    const done = completed.length > 0;
    const routeOps = (woDoc?.operations || []).length;
    push({
      department: "production", label: DEPARTMENT_META.production.label, doneLabel: "Sewn", applicable: true, done,
      at: completed[0]?.at || null, by: completed[0]?.by || null,
      summary: done
        ? `Completion recorded by ${completed[0].by.name || "the supervisor"}${operations.length ? ` · ${operations.length} of ${routeOps || operations.length} operation(s) scanned` : ""}`
        : operations.length ? `${operations.length} of ${routeOps || operations.length} operation(s) scanned so far — not yet marked complete` : "",
      detail: { operations, unassigned, completion: completed, routeOperations: routeOps, scanCount: events.length },
    });
  }

  // qc — checkpoint by checkpoint
  {
    const progress = qcStages.buildPieceProgress(inspections, qcStageList);
    const checkpoints = (progress.stages || []).map((s) => ({
      code: str(s.stageCode), name: str(s.stageName), serial: s.serial ?? null, state: str(s.state), scans: s.scans ?? 0, reworkCount: s.reworkCount ?? 0,
      latestAt: s.latestAt || null, inspectors: (s.inspectors || []).map((i) => str(i.name)).filter(Boolean),
      history: (s.history || []).map((h) => ({ status: str(h.status), at: h.at || null, by: str(h.by) })),
    }));
    const rows = inspections.map((i) => ({
      at: i.inspectedAt || null, by: { name: str(i.inspectedByQCName), id: str(i.inspectedByBiometricId) },
      status: str(i.status), checkpoint: str(i.stageName) || (i.stageCode ? str(i.stageCode) : ""), round: i.reworkRound ?? null, isRework: Boolean(i.isRework), offline: Boolean(i.recordedOffline),
      defects: [
        ...(i.defects || []).map((d) => ({ operation: str(d.operationName) || str(d.operationCode), code: str(d.operationCode), types: (d.types || []).map((t) => str(t.name) || str(t.code)).filter(Boolean), operators: (d.operators || []).map((o) => str(o.operatorName) || str(o.operatorId)).filter(Boolean) })),
        ...((i.defectTypes || []).length ? [{ operation: "", code: "", types: (i.defectTypes || []).map((t) => str(t.name) || str(t.code) || str(t)).filter(Boolean), operators: [] }] : []),
      ],
    }));
    const latest = rows[rows.length - 1] || null;
    const configured = qcStageList.length > 0;
    const done = progress.rejected ? false : configured ? Boolean(progress.complete) : Boolean(latest && latest.status === "passed");
    const summary = progress.rejected
      ? `Rejected at ${str(progress.rejectedStage?.stageName || progress.rejectedStage || "QC")}${progress.rejectedBy ? ` by ${str(progress.rejectedBy)}` : ""}`
      : done ? `Passed${configured ? ` all ${checkpoints.length} checkpoint(s)` : ""}${latest?.by?.name ? ` · last by ${latest.by.name}` : ""}`
        : (progress.openRework || []).length ? `Rework open at ${progress.openRework.map((o) => str(o.stageName)).join(", ")}`
          : rows.length ? `${rows.length} inspection(s) so far — ${progress.currentStage ? `at ${str(progress.currentStage.stageName)}` : "not all checkpoints passed"}` : "";
    push({
      department: "qc", label: DEPARTMENT_META.qc.label, doneLabel: "Passed QC", applicable: true, done,
      at: done ? (latest?.at || null) : null, by: done ? (latest?.by || null) : null, summary,
      detail: { checkpoints, inspections: rows, rejected: Boolean(progress.rejected), complete: Boolean(progress.complete), openRework: (progress.openRework || []).map((o) => str(o.stageName)), reworkCount: progress.reworkCount ?? 0, unstagedScans: progress.unstagedScans ?? 0, configured },
    });
  }

  // packaging — the carton, else the legacy record
  let cartonView = null;
  {
    /* the work order's own packaging record is the same event as the carton
       when both exist — shown only where no carton holds the piece */
    const legacy = carton ? null : ((woDoc?.packagingRecords || []).find((p) => (p.unitNumbers || []).map(Number).includes(unit)) || null);
    if (carton) {
      const session = (carton.additions || []).find((a) => (a.items || []).some((it) => String(it.workOrderId) === String(woId) && (it.unitNumbers || []).map(Number).includes(unit))) || null;
      const line = (carton.lines || []).find((l) => String(l.workOrderId) === String(woId) && (l.unitNumbers || []).map(Number).includes(unit)) || null;
      cartonView = {
        id: String(carton._id), number: str(carton.cartonNumber), status: str(carton.status), quantity: Number(carton.totalQuantity) || 0,
        packedAt: session?.at || carton.packedAt || null, packedBy: personOf(session?.packedBy || carton.packedBy),
        weightKg: carton.weightKg ?? null, madeFor: line?.employee?.employeeName ? `${line.employee.employeeName}${line.employee.employeeUIN ? ` (${line.employee.employeeUIN})` : ""}` : "",
        dispatchedAt: carton.dispatchedAt || null, dispatchedBy: carton.dispatchedBy ? personOf(carton.dispatchedBy) : null, challanNumber: str(carton.dispatchChallanNumber), challanId: carton.dispatchChallanId ? String(carton.dispatchChallanId) : null,
      };
    }
    const done = Boolean(cartonView) || Boolean(legacy);
    push({
      department: "packaging", label: DEPARTMENT_META.packaging.label, doneLabel: "Packed", applicable: true, done,
      at: cartonView?.packedAt || legacy?.packagedAt || null, by: cartonView?.packedBy || (legacy ? personOf(legacy.packagedBy) : null),
      summary: cartonView ? `In carton ${cartonView.number}${cartonView.packedBy.name ? ` · packed by ${cartonView.packedBy.name}` : ""}` : legacy ? `Packed (${legacy.packagedQuantity} pcs batch)${legacy.packagedBy ? ` by ${legacy.packagedBy}` : ""} — no carton recorded` : "",
      detail: { carton: cartonView, legacy: legacy ? { at: legacy.packagedAt || null, by: personOf(legacy.packagedBy), quantity: Number(legacy.packagedQuantity) || 0, type: str(legacy.packagingType), notes: str(legacy.notes) } : null },
    });
  }

  // dispatch — the challan the carton left on
  {
    let challan = null;
    if (cartonView?.challanId) {
      const c = await DispatchChallan.findById(cartonView.challanId).lean();
      if (c) challan = { number: str(c.challanNumber), at: c.createdAt || cartonView.dispatchedAt || null, by: cartonView.dispatchedBy || personOf(c.dispatchedBy), cartonCount: c.cartonCount ?? (c.cartons || []).length, totalUnits: c.totalUnits ?? null, transport: c.transport ? { vehicleNumber: str(c.transport.vehicleNumber), driverName: str(c.transport.driverName), driverPhone: str(c.transport.driverPhone), transporter: str(c.transport.transporter), lrNumber: str(c.transport.lrNumber) } : null, notes: str(c.notes) };
    }
    const done = Boolean(challan) || cartonView?.status === "dispatched";
    push({
      department: "dispatch", label: DEPARTMENT_META.dispatch.label, doneLabel: "Dispatched", applicable: true, done,
      at: challan?.at || cartonView?.dispatchedAt || null, by: challan?.by || cartonView?.dispatchedBy || null,
      summary: done ? `Left on challan ${challan?.number || cartonView?.challanNumber || ""}${(challan?.by?.name || cartonView?.dispatchedBy?.name) ? ` · by ${challan?.by?.name || cartonView?.dispatchedBy?.name}` : ""}` : "",
      detail: { challan },
    });
  }

  /* ── where it stands ────────────────────────────────────────────────── */
  const ordered = DEPARTMENTS.map((d) => stages.find((s) => s.department === d)).filter(Boolean);
  const applicable = ordered.filter((s) => s.applicable);
  const doneStages = applicable.filter((s) => s.done);
  const current = [...doneStages].sort((a, b) => DEPARTMENT_META[b.department].order - DEPARTMENT_META[a.department].order)[0] || null;
  const next = applicable.find((s) => !s.done) || null;
  const qc = ordered.find((s) => s.department === "qc");

  return {
    recognised: true,
    barcode: `WO-${String(wo.id).slice(-8).toLowerCase()}-${String(unit).padStart(3, "0")}`,
    scanned: raw,
    unit,
    piece: {
      workOrder: { id: wo.id, number: wo.number, quantity: wo.quantity, status: wo.status, priority: wo.priority, deadline: wo.assignedDeadline || wo.plannedEnd || null },
      order: header ? { moId: header.moId, moNumber: header.moNumber, poNumber: header.poNumber || "", customerName: header.customerName, orderType: header.orderType, deliveryDate: header.deliveryDate || null, orderOrigin: header.orderOrigin || "" } : (wo.moId ? { moId: wo.moId, moNumber: "", customerName: wo.customerName } : null),
      product: { name: wo.product, reference: wo.reference, variant: wo.variant, size: wo.size, colour: wo.colour, image: wo.image || null, category: wo.category || "" },
    },
    current: current ? { department: current.department, label: current.label, doneLabel: current.doneLabel, at: current.at, by: current.by } : null,
    next: next ? { department: next.department, label: next.label } : null,
    rejected: Boolean(qc?.detail?.rejected),
    counts: { done: doneStages.length, remaining: applicable.length - doneStages.length, applicable: applicable.length },
    stages: ordered,
  };
}

module.exports = { pieceJourney, barcodeForms };
