// services/ppc/control/ledger.service.js
//
// THE ONE READ OF "WHAT WAS DONE", FOR THE PPC CONTROL CENTER.
//
// Every figure PPC shows about production — per order, per work order, per
// product/variant, per department, per hour, per day, per person — is counted
// from the department's OWN book, never typed in and never cached in a second
// collection:
//
//   cutting     CuttingMasterRecord.entries    (quantityCut at timestamp)
//   embroidery, printing, washing, trimming, ironing
//               FinishingScan                  (one row per piece, doneAt)
//   production  ProductionCompletionScanRecord (the mark-done ledger, one
//               scan per barcode, scannedAt)
//   qc          QCInspection that PASSED       (first pass per barcode)
//   packaging   WorkOrder.packagingRecords     (packagedQuantity at packagedAt)
//   dispatch    DispatchChallan                (per product line, createdAt)
//
// This is the same set of sources services/ppc/orderTargets.service.js reads
// for a target's "done" figure, with two differences that the control center
// needs and a target evaluation does not: every event names its WORK ORDER,
// its UNIT (where the source records one) and the PERSON who recorded it, so
// the same list can be pivoted by product, variant, work order, person, hour
// or day without a second read; and a production barcode is accepted in BOTH
// of the forms the floor has printed — `WO-<8 hex>-NNN` and `WO-<24 hex>-NNN`
// — because current labels carry the full id while the older matchers only
// knew the short one (productionCompletionRoutes.js:31-40 explains).
//
// Company scoping is the packaging module's: a work order belongs to a company
// through `salesLineLink.companyId`, and everything else is reached from the
// work order. A department book row whose work order is not in the company's
// index is simply not counted.
"use strict";

const mongoose = require("mongoose");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const FinishingScan = require("../../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const CuttingMasterRecord = require("../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const ProductionCompletionScanRecord = require("../../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const QCInspection = require("../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const DispatchChallan = require("../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const packagingAccess = require("../../../routes/CMS_Routes/Manufacturing/Packaging/packagingAccess");
const { displayWorkOrderNumber, shortIdOf } = require("../../manufacturing/workOrderNumber");
const { DEPARTMENT_META } = require("../orderTargets.evaluate");

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));

/** Departments in production order — the same list targets are set against. */
const DEPARTMENTS = Object.keys(DEPARTMENT_META).sort((a, b) => DEPARTMENT_META[a].order - DEPARTMENT_META[b].order);
const FINISHING = new Set(["embroidery", "printing", "washing", "trimming", "ironing"]);
/** Stages every order passes; a finishing stage only if the order uses it. */
const CORE = new Set(["cutting", "production", "qc", "packaging", "dispatch"]);

/* ── work orders, the spine everything hangs off ─────────────────────────── */

/** A label the floor and the screen agree on: a stored `WO-<24 hex>` is the
    id in disguise, so it is shown in the eight-character form every barcode
    carries; anything else stored is shown as stored. */
function woNumberOf(wo) {
  const stored = String(wo?.workOrderNumber || "").trim();
  if (/^WO-[0-9a-f]{24}$/i.test(stored)) return `WO-${shortIdOf(wo._id)}`;
  return displayWorkOrderNumber(wo);
}

/** "M · Blue" — every attribute value, in order. */
function variantOf(attrs) {
  const vals = (attrs || []).filter((a) => a && a.value != null && String(a.value).trim() !== "").map((a) => String(a.value).trim());
  return vals.length ? vals.join(" · ") : "";
}
/** The size attribute alone, if one is named. */
function sizeOf(attrs) {
  const a = (attrs || []).find((x) => /size/i.test(String(x?.name || "")));
  return a?.value ? String(a.value) : "";
}
function colourOf(attrs) {
  const a = (attrs || []).find((x) => /colou?r|shade/i.test(String(x?.name || "")));
  return a?.value ? String(a.value) : "";
}

const WO_SELECT = "_id workOrderNumber customerRequestId customerName quantity originalQuantity stockItemId stockItemName stockItemReference variantId variantAttributes status priority packagingRecords assignedDeadline timeline createdAt updatedAt salesLineLink.lineRef isSplitOrder parentWorkOrderId forwardedToVendor cuttingProgress cuttingStatus qcCompletion.completedQuantity packagedQuantity dispatchedQuantity bulkDispatchHistory planningState productionCompletion.overallCompletedQuantity";

/**
 * The company's work orders, indexed every way the ledger needs them.
 * `moIds` / `woIds` narrow the read; both null reads the whole company.
 * Cancelled work orders are kept in the index (their scans still exist) but
 * flagged, so a caller can leave them out of a quantity.
 */
async function woIndex(companyId, { moIds = null, woIds = null, includeCancelled = true } = {}) {
  /* Only work orders that belong to an order: a work order with no
     customerRequestId is a demo or a legacy stray, and the control center is
     about orders. */
  const filter = { customerRequestId: { $ne: null } };
  if (Array.isArray(moIds)) filter.customerRequestId = { $in: moIds.filter(isId).map(oid) };
  if (Array.isArray(woIds)) filter._id = { $in: woIds.filter(isId).map(oid) };
  const rows = await packagingAccess.findWorkOrders(companyId, filter, WO_SELECT)
    .populate("stockItemId", "name reference category genderCategory images variants._id variants.images variants.sku")
    .lean();
  const byId = new Map(), byShort = new Map(), byMo = new Map();
  const list = [];
  for (const w of rows) {
    if (!includeCancelled && w.status === "cancelled") continue;
    const si = w.stockItemId && typeof w.stockItemId === "object" ? w.stockItemId : null;
    let image = null;
    if (si && w.variantId) { const v = (si.variants || []).find((x) => String(x._id) === String(w.variantId)); if (v?.images?.[0]) image = v.images[0]; }
    if (!image && si) { for (const v of si.variants || []) if (v?.images?.[0]) { image = v.images[0]; break; } }
    if (!image && si?.images?.[0]) image = si.images[0];
    const entry = {
      id: String(w._id), shortId: shortIdOf(w._id).toLowerCase(), number: woNumberOf(w),
      moId: w.customerRequestId ? String(w.customerRequestId) : "",
      customerName: w.customerName || "",
      stockItemId: si ? String(si._id) : (w.stockItemId ? String(w.stockItemId) : ""),
      product: si?.name || w.stockItemName || "", reference: si?.reference || w.stockItemReference || "",
      category: si?.category || "", genderCategory: si?.genderCategory || "", image,
      variantId: w.variantId || "", variantAttributes: (w.variantAttributes || []).map((a) => ({ name: a?.name || "", value: a?.value == null ? "" : String(a.value) })),
      variant: variantOf(w.variantAttributes), size: sizeOf(w.variantAttributes), colour: colourOf(w.variantAttributes),
      quantity: Number(w.quantity) || 0, status: w.status || "", priority: w.priority || "",
      lineRef: w.salesLineLink?.lineRef || "", isSplit: Boolean(w.isSplitOrder), parentWorkOrderId: w.parentWorkOrderId ? String(w.parentWorkOrderId) : null,
      forwardedToVendor: Boolean(w.forwardedToVendor),
      assignedDeadline: w.assignedDeadline || null, plannedEnd: w.timeline?.plannedEndDate || null, plannedStart: w.timeline?.plannedStartDate || null,
      createdAt: w.createdAt || null, planningState: w.planningState || "unknown",
      /* The department's own running figures, as recorded — not the ledger. */
      recorded: {
        cuttingCompleted: Number(w.cuttingProgress?.completed) || 0, cuttingStatus: w.cuttingStatus || "",
        qcCompleted: Number(w.qcCompletion?.completedQuantity) || 0,
        packagedQuantity: Number(w.packagedQuantity) || 0, dispatchedQuantity: Number(w.dispatchedQuantity) || 0,
        bulkDispatched: (w.bulkDispatchHistory || []).reduce((n, h) => n + (Number(h.quantity) || 0), 0),
        overallCompleted: Number(w.productionCompletion?.overallCompletedQuantity) || 0,
      },
      packagingRecords: w.packagingRecords || [],
    };
    byId.set(entry.id, entry); byShort.set(entry.shortId, entry);
    if (entry.moId) { if (!byMo.has(entry.moId)) byMo.set(entry.moId, []); byMo.get(entry.moId).push(entry); }
    list.push(entry);
  }
  return { byId, byShort, byMo, list, companyId: String(companyId) };
}

/* ── events ──────────────────────────────────────────────────────────────── */

const BARCODE = /^WO-([0-9a-f]{8}|[0-9a-f]{24})-(\d+)$/i;
/** `{ wo, unit }` for a barcode in either printed form, or null. */
function resolveBarcode(index, barcode) {
  const m = BARCODE.exec(String(barcode || "").trim());
  if (!m) return null;
  const wo = index.byShort.get(m[1].slice(-8).toLowerCase());
  return wo ? { wo, unit: Number(m[2]) } : null;
}

const inRange = (at, start, end) => (!start || at >= start) && (!end || at < end);
const rangeQuery = (field, start, end) => (start || end ? { [field]: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } } : {});
/* A unit numbered above the work order's quantity is a real scan of a label
   that should not exist (a re-printed sheet, a wrong quantity). The
   Production Record's own screens report it as "extra", not as "done", so the
   ledger flags it and `unitsOf` leaves it out — the two then agree. */
const ev = (department, at, qty, wo, extra = {}) => ({
  department, at: new Date(at), qty, moId: wo ? wo.moId : (extra.moId || ""), woId: wo ? wo.id : null,
  unit: extra.unit ?? null, beyond: Boolean(wo && extra.unit != null && wo.quantity > 0 && extra.unit > wo.quantity),
  personKey: extra.personKey || "", personName: extra.personName || "", source: extra.source || "",
});

/**
 * Completion events for the work orders in `index`, one department at a time.
 * `[start, end)` bound the read; both null reads everything.
 * Each event: `{ department, at, qty, moId, woId, unit, personKey, personName }`.
 */
async function readDepartment(department, index, start = null, end = null) {
  const ids = index.list.map((w) => oid(w.id));
  if (!ids.length) return [];
  const out = [];

  if (FINISHING.has(department)) {
    const rows = await FinishingScan.find({ stage: department, workOrderId: { $in: ids }, ...rangeQuery("doneAt", start, end) })
      .select("workOrderId unitNumber doneAt doneBy.name doneBy.userId doneBy.employeeId source").lean();
    for (const r of rows) {
      const wo = index.byId.get(String(r.workOrderId)); if (!wo) continue;
      out.push(ev(department, r.doneAt, 1, wo, { unit: r.unitNumber, personKey: r.doneBy?.userId || r.doneBy?.employeeId || r.doneBy?.name || "", personName: r.doneBy?.name || "", source: r.source || "" }));
    }
    return out;
  }

  if (department === "cutting") {
    const q = { "entries.woId": { $in: ids } };
    /* The day document is keyed by the UTC day; read a day either side of the
       bounds and let each entry's own timestamp decide. */
    if (start || end) {
      q.date = {};
      if (start) q.date.$gte = new Date(start.getTime() - 86400000).toISOString().slice(0, 10);
      if (end) q.date.$lte = new Date(end.getTime() + 86400000).toISOString().slice(0, 10);
    }
    const docs = await CuttingMasterRecord.find(q).select("employeeId employeeName entries.woId entries.quantityCut entries.timestamp entries.recordedBy").lean();
    for (const d of docs) for (const e of d.entries || []) {
      const wo = e.woId ? index.byId.get(String(e.woId)) : null; if (!wo) continue;
      const at = e.timestamp; if (!at || !inRange(at, start, end)) continue;
      out.push(ev(department, at, Number(e.quantityCut) || 0, wo, { personKey: String(e.recordedBy?.id || d.employeeId || ""), personName: e.recordedBy?.name || d.employeeName || "" }));
    }
    return out;
  }

  if (department === "production") {
    const q = {};
    if (start) q.$gte = new Date(start.getTime() - 86400000);
    if (end) q.$lte = new Date(end.getTime() + 86400000);
    const docs = await ProductionCompletionScanRecord.find(Object.keys(q).length ? { date: q } : {}).select("date scans.barcodeId scans.scannedAt scans.scannedBy").sort({ date: 1 }).lean();
    const seen = new Set();
    for (const d of docs) for (const s of d.scans || []) {
      const r = resolveBarcode(index, s.barcodeId); if (!r) continue;
      const key = `${r.wo.id}#${r.unit}`; if (seen.has(key)) continue; seen.add(key);
      const at = s.scannedAt || d.date; if (!inRange(at, start, end)) continue;
      out.push(ev(department, at, 1, r.wo, { unit: r.unit, personKey: String(s.scannedBy || "").trim().toLowerCase(), personName: String(s.scannedBy || "").trim() }));
    }
    return out;
  }

  if (department === "qc") {
    const shorts = index.list.map((w) => w.shortId);
    const rows = await QCInspection.find({ status: "passed", $or: [{ workOrderId: { $in: ids } }, { workOrderShortId: { $in: shorts.concat(shorts.map((s) => s.toUpperCase())) } }], ...rangeQuery("inspectedAt", start, end) })
      .select("barcodeId workOrderId workOrderShortId inspectedAt inspectedByQCName inspectedByBiometricId inspectedByQCId stageName").sort({ inspectedAt: 1 }).lean();
    const seen = new Set();
    for (const r of rows) {
      let wo = r.workOrderId ? index.byId.get(String(r.workOrderId)) : null;
      let unit = null;
      const parsed = resolveBarcode(index, r.barcodeId);
      if (parsed) { wo = wo || parsed.wo; unit = parsed.unit; }
      if (!wo && r.workOrderShortId) wo = index.byShort.get(String(r.workOrderShortId).toLowerCase());
      if (!wo) continue;
      const key = String(r.barcodeId || `${wo.id}#${unit}`).toUpperCase(); if (seen.has(key)) continue; seen.add(key);
      out.push(ev(department, r.inspectedAt, 1, wo, { unit, personKey: r.inspectedByBiometricId || r.inspectedByQCId || r.inspectedByQCName || "", personName: r.inspectedByQCName || "", source: r.stageName || "" }));
    }
    return out;
  }

  if (department === "packaging") {
    for (const wo of index.list) for (const r of wo.packagingRecords || []) {
      const at = r.packagedAt; if (!at || !inRange(at, start, end)) continue;
      const qty = Number(r.packagedQuantity) || (r.unitNumbers || []).length; if (!qty) continue;
      out.push({ ...ev(department, at, qty, wo, { personKey: String(r.packedByUserId || r.packagedBy || ""), personName: r.packagedBy || "", source: r.cartonNumber || "" }), units: (r.unitNumbers || []).map(Number).filter(Number.isFinite) });
    }
    return out;
  }

  if (department === "dispatch") {
    const moIds = [...index.byMo.keys()].filter(isId).map(oid);
    if (!moIds.length) return [];
    const rows = await DispatchChallan.find({ manufacturingOrderId: { $in: moIds }, ...rangeQuery("createdAt", start, end) })
      .select("manufacturingOrderId challanNumber dispatchType persons.employeeName persons.employeeUIN persons.products.workOrderId persons.products.quantity bulkProducts.workOrderId bulkProducts.quantity totalUnits dispatchedBy createdAt").lean();
    for (const c of rows) {
      const moId = String(c.manufacturingOrderId);
      const lines = [];
      for (const p of c.persons || []) for (const pr of p.products || []) lines.push({ woId: pr.workOrderId, qty: pr.quantity, person: p.employeeName || "", personKey: p.employeeUIN || p.employeeName || "" });
      for (const pr of c.bulkProducts || []) lines.push({ woId: pr.workOrderId, qty: pr.quantity, person: "", personKey: "" });
      let placed = 0;
      for (const l of lines) {
        const wo = l.woId ? index.byId.get(String(l.woId)) : null;
        const qty = Number(l.qty) || 0; if (!qty) continue;
        if (wo) { placed += qty; out.push(ev(department, c.createdAt, qty, wo, { personKey: l.personKey, personName: l.person, source: c.challanNumber || "" })); }
      }
      /* A challan whose lines name no work order still moved units: keep the
         order-level figure, unattributed to a work order. */
      const rest = (Number(c.totalUnits) || 0) - placed;
      if (rest > 0 && index.byMo.has(moId)) out.push(ev(department, c.createdAt, rest, null, { moId, source: c.challanNumber || "", personName: c.dispatchedBy || "" }));
    }
    return out;
  }
  return [];
}

/** Every department at once (or the ones asked for): `Map department → events`. */
async function readEvents(index, { departments = DEPARTMENTS, start = null, end = null } = {}) {
  const out = new Map();
  await Promise.all(departments.map(async (d) => { out.set(d, await readDepartment(d, index, start, end)); }));
  return out;
}

/* ── arithmetic over an event list ───────────────────────────────────────── */

const sum = (events) => events.reduce((n, e) => n + (e.beyond ? 0 : Number(e.qty) || 0), 0);
/** Distinct units, for the departments that record one; else the quantity.
    A unit is distinct PER WORK ORDER — unit 1 of two work orders is two
    pieces — so the key carries the work order. */
function unitsOf(events) {
  const units = new Set();
  let unitless = 0;
  for (const e of events) {
    if (e.beyond) continue;
    const wo = e.woId || "";
    if (Array.isArray(e.units) && e.units.length) e.units.forEach((u) => units.add(`${wo}#${u}`));
    else if (e.unit != null) units.add(`${wo}#${e.unit}`);
    else unitless += Number(e.qty) || 0;
  }
  return units.size + unitless;
}
/** Units recorded beyond the work order's quantity — real scans, reported apart. */
function beyondOf(events) {
  const units = new Set();
  for (const e of events) if (e.beyond) units.add(`${e.woId || ""}#${e.unit}`);
  return units.size;
}
const lastAt = (events) => events.reduce((m, e) => (e.at > m ? e.at : m), null);
const firstAt = (events) => events.reduce((m, e) => (!m || e.at < m ? e.at : m), null);
function groupBy(events, keyOf) {
  const m = new Map();
  for (const e of events) { const k = keyOf(e); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
  return m;
}

module.exports = {
  DEPARTMENTS, DEPARTMENT_META, FINISHING, CORE, isId, oid,
  woIndex, woNumberOf, variantOf, sizeOf, colourOf, resolveBarcode,
  readDepartment, readEvents, sum, unitsOf, beyondOf, lastAt, firstAt, groupBy,
};
