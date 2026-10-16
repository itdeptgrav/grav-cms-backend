// services/manufacturing/finishingPieces.js
//
// WHAT A PIECE BARCODE IS, AND WHETHER A STAGE HAS DONE IT.
//
// Lifted verbatim out of routes/CMS_Routes/Manufacturing/Finishing/
// finishingRoutes.js (15 Oct 2026) so that the SECOND writer of
// `finishingscans` — a paired hand-scanner device, which has no session and
// posts to routes/Barcode_Scan_Punchings/remoteStationRoutes.js — resolves a
// barcode, refuses an ambiguous short id and reports "already done by X at T"
// with exactly the code the browser path uses. Two copies of this rule would
// be two ways for the same garment to be counted.
//
// Everything here is a read. The write — the insert and its duplicate-key
// handling — is `recordDone`, also here, so both routers answer every barcode
// the same way: saved | already | invalid.
"use strict";

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const FinishingScan = require("../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const { displayWorkOrderNumber } = require("./workOrderNumber");
const pkg = require("../../routes/CMS_Routes/Manufacturing/Packaging/packagingAccess");

const { findWorkOrders, isId, oid, str } = pkg;

/** WO-<short id>-<unit>, the form the scanners write. Case-insensitive on the id. */
function parseBarcode(raw) {
  const parts = String(raw || "").trim().split("-");
  if (parts.length < 3 || parts[0].toUpperCase() !== "WO") return null;
  const unit = parseInt(parts[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  const shortId = parts[1].toLowerCase();
  return { shortId, unit, barcode: `WO-${shortId}-${String(unit).padStart(3, "0")}` };
}

/**
 * This company's work orders, indexed by the short id a barcode carries. A
 * short id two work orders share resolves to NOTHING — an ambiguous scan is a
 * question for a person, never a guess.
 */
async function workOrderIndex(companyId, select) {
  const wos = await findWorkOrders(companyId, {}, select).lean();
  const byShort = new Map();
  for (const wo of wos) {
    const s = String(wo._id).slice(-8).toLowerCase();
    byShort.set(s, byShort.has(s) ? null : wo);
  }
  return byShort;
}

const WO_SELECT = "_id workOrderNumber quantity customerRequestId stockItemId stockItemName stockItemReference variantId variantAttributes";

async function orderInfo(ids) {
  const clean = [...new Set(ids.filter(Boolean).map(String))].filter(isId);
  if (!clean.length) return new Map();
  const mos = await CustomerRequest.find({ _id: { $in: clean.map(oid) } })
    .select("requestId requestType customerInfo.name").lean();
  return new Map(mos.map((m) => [String(m._id), { moNumber: `MO-${m.requestId}`, customerName: m.customerInfo?.name || "", requestType: m.requestType || "" }]));
}

/**
 * Resolve a list of raw barcodes against this company's work orders.
 * Returns rows in input order, each either resolved (wo, unit, order) or
 * invalid (reason). Duplicates within the list are collapsed to the first.
 */
async function resolveBarcodes(companyId, rawList) {
  const seen = new Set();
  const rows = [];
  for (const raw of rawList) {
    const p = parseBarcode(raw);
    const key = p ? p.barcode : String(raw || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(p ? { input: String(raw).trim(), ...p } : { input: String(raw).trim(), barcode: key, invalid: "Not a piece barcode — expected WO-<id>-<unit>." });
  }
  const need = rows.some((r) => !r.invalid);
  const index = need ? await workOrderIndex(companyId, WO_SELECT) : new Map();
  for (const r of rows) {
    if (r.invalid) continue;
    const wo = index.get(r.shortId);
    if (wo === null) { r.invalid = `Two work orders share the id ${r.shortId} — this barcode cannot be resolved.`; continue; }
    if (!wo) { r.invalid = `No work order of this company matches ${r.shortId}.`; continue; }
    if (r.unit > (wo.quantity || 0)) { r.invalid = `Piece ${r.unit} is past the ${wo.quantity || 0} ordered on ${displayWorkOrderNumber(wo)}.`; continue; }
    r.wo = wo;
  }
  const orders = await orderInfo(rows.filter((r) => r.wo).map((r) => r.wo.customerRequestId));
  for (const r of rows) if (r.wo) r.order = orders.get(String(r.wo.customerRequestId || "")) || null;
  return rows;
}

/** Existing scans of this stage for the resolved rows, keyed "woId|unit". */
async function existingScans(stage, rows) {
  const resolved = rows.filter((r) => r.wo);
  if (!resolved.length) return new Map();
  const or = resolved.map((r) => ({ workOrderId: r.wo._id, unitNumber: r.unit }));
  const docs = await FinishingScan.find({ stage, $or: or })
    .select("workOrderId unitNumber doneAt doneBy source device").lean();
  return new Map(docs.map((d) => [`${d.workOrderId}|${d.unitNumber}`, d]));
}

const pieceView = (r) => ({
  barcode: r.barcode,
  input: r.input,
  unit: r.unit ?? null,
  workOrder: r.wo ? {
    _id: r.wo._id,
    workOrderNumber: displayWorkOrderNumber(r.wo),
    shortId: r.shortId,
    quantity: r.wo.quantity || 0,
    productName: r.wo.stockItemName || "",
    productReference: r.wo.stockItemReference || "",
    variantAttributes: r.wo.variantAttributes || [],
    productImage: r.photo || null,
  } : null,
  order: r.order || null,
});

/** A device clock is a hint: nothing from the future, nothing older than 30 days. */
function plausibleAt(value, fallback) {
  const t = value ? new Date(value) : null;
  if (!t || Number.isNaN(t.getTime())) return fallback;
  const ms = t.getTime();
  if (ms > fallback.getTime() + 5 * 60 * 1000) return fallback;
  if (ms < fallback.getTime() - 30 * 24 * 60 * 60 * 1000) return fallback;
  return t;
}

const SOURCES = new Set(["scanner", "camera", "manual", "sync", "device"]);

/**
 * Record scans as done at a stage. Idempotent. Every scan is answered:
 * saved | already | invalid.
 *
 * @param scans   [{ barcode, at, source, notes, doneBy?, device? }] — `doneBy`
 *                per scan when a device attributes each piece to the operator
 *                who scanned it; otherwise `who` is used for all of them.
 * @param who     the default doneBy (the session, on the browser path)
 * @returns { results, counts, saved }
 */
async function recordDone({ stage, companyId, scans, who, now = new Date() }) {
  const rows = await resolveBarcodes(companyId, scans.slice(0, 500).map((s) => s?.barcode));
  const byBarcode = new Map(rows.map((r) => [r.barcode, r]));
  const done = await existingScans(stage, rows);

  const results = [];
  const toInsert = [];
  const seenKey = new Set();
  for (const s of scans) {
    const p = parseBarcode(s?.barcode);
    const r = p ? byBarcode.get(p.barcode) : null;
    const input = String(s?.barcode || "").trim();
    if (!r || r.invalid) { results.push({ barcode: input, input, status: "invalid", reason: r?.invalid || "Not a piece barcode — expected WO-<id>-<unit>." }); continue; }
    const key = `${r.wo._id}|${r.unit}`;
    const prior = done.get(key);
    /* `priorDevice` lets the device router recognise ITS OWN earlier write on a
       retried event and answer "saved" rather than "already". */
    if (prior) { results.push({ ...pieceView(r), status: "already", doneAt: prior.doneAt, doneBy: prior.doneBy, priorDevice: prior.device || null }); continue; }
    if (seenKey.has(key)) { results.push({ ...pieceView(r), status: "already", duplicateInBatch: true }); continue; }
    seenKey.add(key);
    toInsert.push({
      stage, companyId,
      workOrderId: r.wo._id, workOrderShortId: r.shortId, workOrderNumber: displayWorkOrderNumber(r.wo),
      unitNumber: r.unit, barcode: r.barcode,
      manufacturingOrderId: r.wo.customerRequestId || null,
      moNumber: r.order?.moNumber || "", customerName: r.order?.customerName || "",
      stockItemId: r.wo.stockItemId || null, productName: r.wo.stockItemName || "",
      variantId: r.wo.variantId || "", variantAttributes: r.wo.variantAttributes || [],
      doneAt: plausibleAt(s?.at, now), recordedAt: now, doneBy: s?.doneBy || who,
      source: SOURCES.has(s?.source) ? s.source : "scanner",
      notes: str(s?.notes).slice(0, 200),
      device: s?.device || null,
    });
    results.push({ ...pieceView(r), status: "saved", doneAt: null, _pending: true });
  }

  let saved = 0;
  if (toInsert.length) {
    try {
      const out = await FinishingScan.insertMany(toInsert, { ordered: false });
      saved = out.length;
      for (const d of out) {
        const row = results.find((x) => x._pending && x.workOrder && String(x.workOrder._id) === String(d.workOrderId) && x.unit === d.unitNumber);
        if (row) { row.doneAt = d.doneAt; row.doneBy = d.doneBy; delete row._pending; }
      }
    } catch (e) {
      /* A race with another device on the same pieces: the index refused
         some; the rest were written. Report each precisely. */
      if (e?.code !== 11000 && !(e?.writeErrors?.length)) throw e;
      const inserted = new Set((e.insertedDocs || []).map((d) => `${d.workOrderId}|${d.unitNumber}`));
      saved = inserted.size;
      for (const row of results) {
        if (!row._pending) continue;
        delete row._pending;
        if (!inserted.has(`${row.workOrder._id}|${row.unit}`)) { row.status = "already"; row.raced = true; }
      }
    }
  }
  for (const row of results) delete row._pending;

  const counts = { saved, already: results.filter((r) => r.status === "already").length, invalid: results.filter((r) => r.status === "invalid").length };
  return { results, counts, saved };
}

module.exports = {
  parseBarcode, workOrderIndex, WO_SELECT, orderInfo, resolveBarcodes, existingScans,
  pieceView, plausibleAt, SOURCES, recordDone,
};
