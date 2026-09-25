// routes/CMS_Routes/Manufacturing/Finishing/finishingRoutes.js
//
// Mount as:
//   app.use("/api/cms/manufacturing/finishing", finishingRoutes);
//
// Every route is under `/:stage/…` where stage is one of the finishing stages
// — printing, washing, trimming, ironing (services/manufacturing/finishingStages.js).
// One router serves all of them because the work is the same shape: a garment
// is scanned and is DONE at that stage.
//
//   GET  /:stage/ping                 reachability (with a session)
//   POST /:stage/preview              what each barcode is, and whether it is already done
//   POST /:stage/done                 record scans — idempotent, from an offline queue or live
//   GET  /:stage/overview?date=       the day: shift hours, people, orders, latest events
//   GET  /:stage/daily?days=          the last N days
//   GET  /:stage/orders               the book of orders with stage progress
//   GET  /:stage/orders/:id           one order's work orders with stage progress and photos
//   GET  /:stage/find-piece?barcode=  one garment through every stage and packing
//   GET  /:stage/report?from=&to=     everything the stage's Excel workbook shows
//
// ── OFFLINE IS THE NORMAL CASE ──────────────────────────────────────────────
// The scan tab keeps every scan on the device and sends them when it can, so
// /done must be safe to receive the same batch twice: the unique index on
// {stage, workOrderId, unitNumber} refuses a repeat per piece, and the answer
// names every barcode — saved, already done (by whom, when), or invalid (why)
// — so the device can settle each one and never has to guess.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const FinishingScan = require("../../../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const PackingCarton = require("../../../../models/CMS_Models/Manufacturing/Packaging/PackingCarton");
const { displayWorkOrderNumber } = require("../../../../services/manufacturing/workOrderNumber");
const { resolvePhotos, resolveVariantAttributes, variantText } = require("../../../../services/manufacturing/workOrderPhoto");
const { buildStageReport, reportWindow } = require("../../../../services/manufacturing/stageReport");
const shift = require("../../../../services/manufacturing/shiftHours");
const { STAGES, STAGE_KEYS } = require("../../../../services/manufacturing/finishingStages");
const access = require("./finishingAccess");

router.use(EmployeeAuthMiddleware);
router.param("stage", (req, res, next) => access.resolveStage(req, res, next));

const canRead = [access.stageReader(), access.stageCompany];
const canRecord = [access.stageDepartment("editor"), access.stageCompany];
const companyOf = (req) => req.finishing.companyId;

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/** WO-<short id>-<unit>, the form the scanners write. Case-insensitive on the id. */
function parseBarcode(raw) {
  const parts = String(raw || "").trim().split("-");
  if (parts.length < 3 || parts[0].toUpperCase() !== "WO") return null;
  const unit = parseInt(parts[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  const shortId = parts[1].toLowerCase();
  return { shortId, unit, barcode: `WO-${shortId}-${String(unit).padStart(3, "0")}` };
}

/** Who this is, from the session — never from the body. */
const actorOf = (req) => ({
  userId: access.str(req.user?.id),
  name: access.str(req.user?.name),
  employeeId: access.str(req.user?.employeeId),
  email: access.str(req.user?.email).toLowerCase(),
  role: access.str(req.user?.role),
});

/**
 * This company's work orders, indexed by the short id a barcode carries. A
 * short id two work orders share resolves to NOTHING — an ambiguous scan is a
 * question for a person, never a guess.
 */
async function workOrderIndex(companyId, select) {
  const wos = await access.findWorkOrders(companyId, {}, select).lean();
  const byShort = new Map();
  for (const wo of wos) {
    const s = String(wo._id).slice(-8).toLowerCase();
    byShort.set(s, byShort.has(s) ? null : wo);
  }
  return byShort;
}

const WO_SELECT = "_id workOrderNumber quantity customerRequestId stockItemId stockItemName stockItemReference variantId variantAttributes";

async function orderInfo(ids) {
  const clean = [...new Set(ids.filter(Boolean).map(String))].filter(access.isId);
  if (!clean.length) return new Map();
  const mos = await CustomerRequest.find({ _id: { $in: clean.map(access.oid) } })
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
    .select("workOrderId unitNumber doneAt doneBy source").lean();
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

const SOURCES = new Set(["scanner", "camera", "manual", "sync"]);

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/ping
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:stage/ping", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, serverTime: new Date().toISOString() });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /:stage/preview   { barcodes: [] }
// ═════════════════════════════════════════════════════════════════════════════
// What each scan IS — the order and the product, the little the scan tab
// shows — and whether this stage has already done it. Reads only.
router.post("/:stage/preview", ...canRead, async (req, res) => {
  try {
    const { barcodes } = req.body || {};
    if (!Array.isArray(barcodes) || !barcodes.length) {
      return res.status(400).json({ success: false, message: "barcodes array is required" });
    }
    const rows = await resolveBarcodes(companyOf(req), barcodes.slice(0, 500));
    const done = await existingScans(req.stage.slug, rows);
    const photos = await resolvePhotos(rows.map((r) => r.wo || {}));
    rows.forEach((r, i) => { r.photo = photos[i]; });

    const items = rows.map((r) => {
      if (r.invalid) return { ...pieceView(r), status: "invalid", reason: r.invalid };
      const d = done.get(`${r.wo._id}|${r.unit}`);
      return d
        ? { ...pieceView(r), status: "done", doneAt: d.doneAt, doneBy: d.doneBy, source: d.source }
        : { ...pieceView(r), status: "new" };
    });
    const counts = { total: items.length, new: 0, done: 0, invalid: 0 };
    for (const it of items) counts[it.status]++;
    return res.json({ success: true, stage: req.stage.slug, items, counts });
  } catch (err) {
    console.error("Finishing preview error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /:stage/done   { scans: [{ barcode, at, source }] }   (or { barcodes: [] })
// ═════════════════════════════════════════════════════════════════════════════
// Idempotent. Every barcode is answered: saved | already | invalid.
router.post("/:stage/done", ...canRecord, async (req, res) => {
  try {
    const body = req.body || {};
    const scans = Array.isArray(body.scans)
      ? body.scans
      : Array.isArray(body.barcodes) ? body.barcodes.map((b) => ({ barcode: b })) : [];
    if (!scans.length) return res.status(400).json({ success: false, message: "scans array is required" });

    const now = new Date();
    const stage = req.stage.slug;
    const who = actorOf(req);
    const rows = await resolveBarcodes(companyOf(req), scans.slice(0, 500).map((s) => s?.barcode));
    const byBarcode = new Map(rows.map((r) => [r.barcode, r]));
    const done = await existingScans(stage, rows);

    const results = [];
    const toInsert = [];
    const seenKey = new Set();
    for (const s of scans) {
      const p = parseBarcode(s?.barcode);
      const r = p ? byBarcode.get(p.barcode) : null;
      const input = String(s?.barcode || "").trim();
      if (!r || r.invalid) { results.push({ barcode: input, status: "invalid", reason: r?.invalid || "Not a piece barcode — expected WO-<id>-<unit>." }); continue; }
      const key = `${r.wo._id}|${r.unit}`;
      const prior = done.get(key);
      if (prior) { results.push({ ...pieceView(r), status: "already", doneAt: prior.doneAt, doneBy: prior.doneBy }); continue; }
      if (seenKey.has(key)) { results.push({ ...pieceView(r), status: "already", duplicateInBatch: true }); continue; }
      seenKey.add(key);
      toInsert.push({
        stage, companyId: companyOf(req),
        workOrderId: r.wo._id, workOrderShortId: r.shortId, workOrderNumber: displayWorkOrderNumber(r.wo),
        unitNumber: r.unit, barcode: r.barcode,
        manufacturingOrderId: r.wo.customerRequestId || null,
        moNumber: r.order?.moNumber || "", customerName: r.order?.customerName || "",
        stockItemId: r.wo.stockItemId || null, productName: r.wo.stockItemName || "",
        variantId: r.wo.variantId || "", variantAttributes: r.wo.variantAttributes || [],
        doneAt: plausibleAt(s?.at, now), recordedAt: now, doneBy: who,
        source: SOURCES.has(s?.source) ? s.source : "scanner",
        notes: access.str(s?.notes).slice(0, 200),
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
    return res.json({
      success: true,
      stage,
      message: saved
        ? `${saved} piece${saved !== 1 ? "s" : ""} marked ${req.stage.doneLabel.toLowerCase()}`
        : counts.already ? "Every one of these pieces was already done." : "Nothing recorded.",
      counts,
      results,
    });
  } catch (err) {
    console.error("Finishing done error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/overview?date=YYYY-MM-DD
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:stage/overview", ...canRead, async (req, res) => {
  try {
    const { start, end, label } = shift.istDayWindow(req.query.date);
    const stage = req.stage.slug;
    const companyId = companyOf(req);

    const scans = await FinishingScan.find({ companyId, stage, doneAt: { $gte: start, $lt: end } })
      .select("doneAt doneBy source barcode workOrderId workOrderNumber unitNumber manufacturingOrderId moNumber customerName productName variantAttributes")
      .sort({ doneAt: -1 })
      .lean();

    const buckets = shift.shiftBuckets().map((b) => ({ ...b, pieces: 0, people: new Map() }));
    const people = new Map();
    const orders = new Map();
    const bump = (map, key, seed, at) => {
      const row = map.get(key) || { ...seed, pieces: 0, firstAt: at, lastAt: at };
      row.pieces++;
      if (at < row.firstAt) row.firstAt = at;
      if (at > row.lastAt) row.lastAt = at;
      map.set(key, row);
    };
    for (const s of scans) {
      const b = buckets[shift.bucketIndexOf(s.doneAt)];
      b.pieces++;
      const pk = s.doneBy?.userId || s.doneBy?.name || "Unknown";
      bump(b.people, pk, { name: s.doneBy?.name || "Unknown" }, s.doneAt);
      bump(people, pk, { name: s.doneBy?.name || "Unknown", employeeId: s.doneBy?.employeeId || "" }, s.doneAt);
      const ok = String(s.manufacturingOrderId || "");
      bump(orders, ok, { manufacturingOrderId: s.manufacturingOrderId, moNumber: s.moNumber || "(no order)", customerName: s.customerName || "" }, s.doneAt);
    }

    /* Order totals: how much of each order this stage has done in total,
       against what the order needs — for the order-wise report. */
    const orderIds = [...orders.keys()].filter(access.isId).map(access.oid);
    let ordered = new Map(), doneTotal = new Map();
    if (orderIds.length) {
      const wos = await access.findWorkOrders(companyId, { customerRequestId: { $in: orderIds } }, "customerRequestId quantity").lean();
      for (const w of wos) { const k = String(w.customerRequestId); ordered.set(k, (ordered.get(k) || 0) + (w.quantity || 0)); }
      const agg = await FinishingScan.aggregate([
        { $match: { companyId, stage, manufacturingOrderId: { $in: orderIds } } },
        { $group: { _id: "$manufacturingOrderId", n: { $sum: 1 } } },
      ]);
      doneTotal = new Map(agg.map((a) => [String(a._id), a.n]));
    }

    /* WORK-ORDER PROGRESS (24 Sep 2026, asked for by the floor: the order-wise
       list could not tell an ironing person WHICH product and variant, or how
       many of it, were done). One row per work order touched on this day: the
       product, its variant (resolved the same way the carton label does, a
       product's only variant included), today's pieces, and the work order's
       total at this stage against its quantity. */
    const woToday = new Map();
    for (const s of scans) {
      const k = String(s.workOrderId);
      const row = woToday.get(k) || { pieces: 0, people: new Map(), firstAt: s.doneAt, lastAt: s.doneAt };
      row.pieces++;
      const pk = s.doneBy?.userId || s.doneBy?.name || "Unknown";
      const p = row.people.get(pk) || { name: s.doneBy?.name || "Unknown", pieces: 0 };
      p.pieces++; row.people.set(pk, p);
      if (s.doneAt < row.firstAt) row.firstAt = s.doneAt;
      if (s.doneAt > row.lastAt) row.lastAt = s.doneAt;
      woToday.set(k, row);
    }
    let workOrders = [];
    const woIds = [...woToday.keys()].filter(access.isId).map(access.oid);
    if (woIds.length) {
      const [wos, woDone] = await Promise.all([
        access.findWorkOrders(companyId, { _id: { $in: woIds } },
          "workOrderNumber quantity stockItemId stockItemName stockItemReference variantId variantAttributes customerRequestId").lean(),
        FinishingScan.aggregate([
          { $match: { companyId, stage, workOrderId: { $in: woIds } } },
          { $group: { _id: "$workOrderId", n: { $sum: 1 } } },
        ]),
      ]);
      const [variants, photos] = await Promise.all([resolveVariantAttributes(wos), resolvePhotos(wos)]);
      const doneBy = new Map(woDone.map((a) => [String(a._id), a.n]));
      const scanOf = new Map(scans.map((x) => [String(x.workOrderId), x]));
      workOrders = wos.map((w, i) => {
        const k = String(w._id);
        const today = woToday.get(k);
        const first = scanOf.get(k) || {};
        const text = variantText(variants[i]);
        const doneTotal = doneBy.get(k) || today.pieces;
        const quantity = w.quantity || 0;
        return {
          workOrderId: k,
          workOrderNumber: displayWorkOrderNumber(w),
          productName: w.stockItemName || first.productName || "",
          reference: w.stockItemReference || "",
          variant: text === "Not specified" ? "" : text.replace(/ †$/, ""),
          photo: photos[i] || null,
          manufacturingOrderId: w.customerRequestId ? String(w.customerRequestId) : (first.manufacturingOrderId ? String(first.manufacturingOrderId) : null),
          moNumber: first.moNumber || "(no order)",
          customerName: first.customerName || "",
          today: today.pieces,
          doneTotal,
          quantity,
          remaining: Math.max(0, quantity - doneTotal),
          people: [...today.people.values()].sort((a, b) => b.pieces - a.pieces),
          firstAt: today.firstAt,
          lastAt: today.lastAt,
        };
      }).sort((a, b) => a.moNumber.localeCompare(b.moNumber) || a.productName.localeCompare(b.productName) || a.variant.localeCompare(b.variant));
    }

    const fin = (map) => [...map.values()].sort((a, b) => b.pieces - a.pieces);
    const hours = buckets.map((b) => ({ key: b.key, label: b.label, short: b.short, outside: b.outside, pieces: b.pieces, people: fin(b.people) }));
    const active = hours.filter((h) => h.pieces > 0);
    const peak = active.reduce((best, h) => (!best || h.pieces > best.pieces ? h : best), null);

    return res.json({
      success: true,
      stage, date: label, shift: shift.SHIFT,
      hours,
      totals: {
        pieces: scans.length,
        activeHours: active.filter((h) => !h.outside).length,
        outsideShift: hours.filter((h) => h.outside).reduce((n, h) => n + h.pieces, 0),
        avgPiecesPerActiveHour: active.length ? Math.round(scans.length / active.length) : 0,
        firstAt: scans.length ? scans[scans.length - 1].doneAt : null,
        lastAt: scans.length ? scans[0].doneAt : null,
        people: fin(people),
        orders: fin(orders).map((o) => ({
          ...o,
          orderQuantity: ordered.get(String(o.manufacturingOrderId || "")) || 0,
          doneTotal: doneTotal.get(String(o.manufacturingOrderId || "")) || o.pieces,
        })),
      },
      peakHour: peak ? { key: peak.key, label: peak.label, pieces: peak.pieces } : null,
      /* No per-scan log here any more (24 Sep 2026: "don't showcase the scans
         records and all logs"). The Excel report keeps the full log. */
      workOrders,
    });
  } catch (err) {
    console.error("Finishing overview error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/daily?days=14&to=YYYY-MM-DD
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:stage/daily", ...canRead, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const last = shift.istDayWindow(req.query.to);
    const first = shift.istDayWindow(shift.shiftDayKey(last.label, -(days - 1)));
    const stage = req.stage.slug;
    const scans = await FinishingScan.find({ companyId: companyOf(req), stage, doneAt: { $gte: first.start, $lt: last.end } })
      .select("doneAt doneBy manufacturingOrderId").lean();

    const byDay = new Map();
    for (let i = 0; i < days; i++) {
      const key = shift.shiftDayKey(first.label, i);
      byDay.set(key, { date: key, pieces: 0, people: new Map(), orders: new Set() });
    }
    for (const s of scans) {
      const d = byDay.get(shift.istDayKeyOf(s.doneAt));
      if (!d) continue;
      d.pieces++;
      const pk = s.doneBy?.userId || s.doneBy?.name || "Unknown";
      const p = d.people.get(pk) || { name: s.doneBy?.name || "Unknown", pieces: 0 };
      p.pieces++; d.people.set(pk, p);
      if (s.manufacturingOrderId) d.orders.add(String(s.manufacturingOrderId));
    }
    const rows = [...byDay.values()].map((d) => ({
      date: d.date, pieces: d.pieces, orders: d.orders.size,
      people: [...d.people.values()].sort((a, b) => b.pieces - a.pieces),
    }));
    const total = rows.reduce((n, r) => n + r.pieces, 0);
    const activeDays = rows.filter((r) => r.pieces > 0).length;
    const best = rows.reduce((b, r) => (!b || r.pieces > b.pieces ? r : b), null);
    return res.json({
      success: true, stage, from: first.label, to: last.label, days: rows,
      totals: { pieces: total, activeDays, avgPerActiveDay: activeDays ? Math.round(total / activeDays) : 0,
        bestDay: best && best.pieces ? { date: best.date, pieces: best.pieces } : null },
    });
  } catch (err) {
    console.error("Finishing daily error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/orders?page&limit&search
// ═════════════════════════════════════════════════════════════════════════════
// The book of orders, with how much of each this stage has done. Which orders
// exist follows Packaging's rule exactly: an order is this company's when one
// of its work orders is; a `pending` order (nothing planned yet) is left out.
router.get("/:stage/orders", ...canRead, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 12);
    const companyId = companyOf(req);
    const stage = req.stage.slug;

    const linked = await access.findWorkOrders(companyId, {}, "customerRequestId status quantity").lean();
    const wosByMo = new Map();
    for (const wo of linked) {
      const key = String(wo.customerRequestId || "");
      if (!key) continue;
      if (!wosByMo.has(key)) wosByMo.set(key, []);
      wosByMo.get(key).push(wo);
    }
    if (!wosByMo.size) return res.json({ success: true, orders: [], pagination: { page: pageNum, limit: limitNum, total: 0, pages: 0 } });

    const moIds = [...wosByMo.keys()].filter(access.isId).map(access.oid);
    const query = { _id: { $in: moIds }, status: "quotation_sales_approved" };
    const all = await CustomerRequest.find(query)
      .select("requestId customerInfo.name createdAt requestType measurementName priority")
      .sort({ updatedAt: -1 }).lean();

    const agg = await FinishingScan.aggregate([
      { $match: { companyId, stage, manufacturingOrderId: { $in: moIds } } },
      { $group: { _id: "$manufacturingOrderId", n: { $sum: 1 }, last: { $max: "$doneAt" } } },
    ]);
    const doneByMo = new Map(agg.map((a) => [String(a._id), a]));

    const needle = String(search || "").trim().toLowerCase();
    const enriched = [];
    for (const mo of all) {
      const wos = wosByMo.get(String(mo._id)) || [];
      if (!wos.length) continue;
      const statuses = wos.map((w) => w.status);
      let derivedStatus = "pending";
      if (statuses.every((s) => s === "completed")) derivedStatus = "completed";
      else if (statuses.some((s) => ["in_progress", "paused", "scheduled", "ready_to_start"].includes(s))) derivedStatus = "in_production";
      else if (statuses.every((s) => s === "pending")) derivedStatus = "pending";
      else if (statuses.some((s) => s === "planned")) derivedStatus = "planning";
      if (derivedStatus === "pending") continue;

      const row = {
        _id: mo._id,
        moNumber: `MO-${mo.requestId}`,
        customerName: mo.customerInfo?.name || "—",
        requestType: mo.requestType || "customer_request",
        measurementName: mo.measurementName || null,
        priority: mo.priority || "medium",
        createdAt: mo.createdAt,
        derivedStatus,
        workOrdersCount: wos.length,
        totalQuantity: wos.reduce((s, w) => s + (w.quantity || 0), 0),
        doneQuantity: doneByMo.get(String(mo._id))?.n || 0,
        lastDoneAt: doneByMo.get(String(mo._id))?.last || null,
      };
      if (needle && ![row.moNumber, row.customerName, row.measurementName].some((v) => String(v || "").toLowerCase().includes(needle))) continue;
      enriched.push(row);
    }
    const total = enriched.length;
    const paged = enriched.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    return res.json({ success: true, stage, orders: paged, pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) } });
  } catch (err) {
    console.error("Finishing orders error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/orders/:id?page&limit&search
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:stage/orders/:id", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 12, search = "" } = req.query;
    if (!access.isId(id)) return access.notFound(res, "manufacturing order");
    const companyId = companyOf(req);
    const stage = req.stage.slug;

    const { visible } = await access.moScope(companyId, id);
    if (!visible) return access.notFound(res, "manufacturing order");
    const mo = await CustomerRequest.findById(id).select("requestId customerInfo requestType measurementName priority createdAt deliveryDeadline").lean();
    if (!mo) return access.notFound(res, "manufacturing order");

    const wos = await access.findWorkOrders(companyId, { customerRequestId: access.oid(id) },
      "workOrderNumber status quantity stockItemId stockItemName stockItemReference variantId variantAttributes packagedQuantity").lean();

    const agg = await FinishingScan.aggregate([
      { $match: { companyId, stage, workOrderId: { $in: wos.map((w) => w._id) } } },
      { $group: { _id: "$workOrderId", units: { $push: "$unitNumber" }, last: { $max: "$doneAt" },
        people: { $addToSet: "$doneBy.name" } } },
    ]);
    const doneByWo = new Map(agg.map((a) => [String(a._id), a]));

    let rows = wos.map((wo) => {
      const d = doneByWo.get(String(wo._id));
      const done = d ? d.units.length : 0;
      return {
        _id: wo._id,
        workOrderNumber: displayWorkOrderNumber(wo),
        status: wo.status,
        quantity: wo.quantity || 0,
        stockItemId: wo.stockItemId || null,
        variantId: wo.variantId || "",
        stockItemName: wo.stockItemName || "—",
        stockItemReference: wo.stockItemReference || "",
        variantAttributes: wo.variantAttributes || [],
        doneQuantity: done,
        remaining: Math.max(0, (wo.quantity || 0) - done),
        doneUnitNumbers: d ? [...d.units].sort((a, b) => a - b) : [],
        lastDoneAt: d?.last || null,
        people: d ? d.people.filter(Boolean) : [],
        packagedQuantity: wo.packagedQuantity || 0,
      };
    });
    rows.sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));

    const needle = String(search || "").trim().toLowerCase();
    if (needle) {
      rows = rows.filter((w) => [w.stockItemName, w.stockItemReference, w.workOrderNumber, ...(w.variantAttributes || []).map((v) => v.value)]
        .some((v) => String(v || "").toLowerCase().includes(needle)));
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 12);
    const paged = rows.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    const photos = await resolvePhotos(paged);
    paged.forEach((w, i) => { w.productImage = photos[i]; });

    const totalQty = wos.reduce((s, w) => s + (w.quantity || 0), 0);
    const doneQty = [...doneByWo.values()].reduce((s, a) => s + a.units.length, 0);

    return res.json({
      success: true, stage,
      order: {
        _id: mo._id, moNumber: `MO-${mo.requestId}`, requestId: mo.requestId,
        customerName: mo.customerInfo?.name || "—", requestType: mo.requestType,
        measurementName: mo.measurementName, priority: mo.priority, createdAt: mo.createdAt,
        deliveryDeadline: mo.deliveryDeadline || mo.customerInfo?.deliveryDeadline || null,
        isMeasurementConversion: mo.requestType === "measurement_conversion",
        totalQuantity: totalQty, doneQuantity: doneQty, remaining: Math.max(0, totalQty - doneQty),
        workOrdersCount: wos.length,
        workOrders: paged,
      },
      pagination: { page: pageNum, limit: limitNum, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limitNum)) },
    });
  } catch (err) {
    console.error("Finishing order detail error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/find-piece?barcode=
// ═════════════════════════════════════════════════════════════════════════════
// One garment's whole finishing journey — trimming, ironing, packing — with
// this stage first. Who, when, and from which device for each.
router.get("/:stage/find-piece", ...canRead, async (req, res) => {
  try {
    const raw = access.str(req.query.barcode);
    if (!raw) return res.status(400).json({ success: false, message: "barcode is required" });
    const [r] = await resolveBarcodes(companyOf(req), [raw]);
    if (!r || r.invalid) return res.json({ success: true, recognised: false, barcode: raw, reason: r?.invalid || "Not a piece barcode." });
    const [photo] = await resolvePhotos([r.wo]);
    r.photo = photo;

    const [scans, carton] = await Promise.all([
      FinishingScan.find({ workOrderId: r.wo._id, unitNumber: r.unit }).select("stage doneAt doneBy source recordedAt").lean(),
      PackingCarton.findOne({ companyId: companyOf(req), lines: { $elemMatch: { workOrderId: r.wo._id, unitNumbers: r.unit } } })
        .select("cartonNumber status packedAt packedBy additions dispatchedAt").lean(),
    ]);
    const byStage = new Map(scans.map((s) => [s.stage, s]));
    const stageView = (key) => {
      const s = byStage.get(key);
      return s ? { done: true, at: s.doneAt, recordedAt: s.recordedAt, by: s.doneBy, source: s.source } : { done: false };
    };
    let packing = { packed: false };
    if (carton) {
      const session = (carton.additions || []).find((a) => (a.items || []).some((it) => String(it.workOrderId) === String(r.wo._id) && (it.unitNumbers || []).includes(r.unit)));
      packing = { packed: true, cartonNumber: carton.cartonNumber, status: carton.status,
        at: session?.at || carton.packedAt, by: session?.packedBy || carton.packedBy, dispatchedAt: carton.dispatchedAt };
    }
    return res.json({
      success: true, recognised: true, stage: req.stage.slug,
      piece: pieceView(r),
      /* Every stage in production order, then packing. */
      stages: { ...Object.fromEntries(STAGE_KEYS.map((k) => [k, stageView(k)])), packing },
      names: Object.fromEntries(STAGE_KEYS.map((k) => [k, STAGES[k].doneLabel])),
      order: [...STAGE_KEYS, "packing"],
    });
  } catch (err) {
    console.error("Finishing find-piece error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /:stage/report?from=YYYY-MM-DD&to=YYYY-MM-DD   (or ?all=1)
// ═════════════════════════════════════════════════════════════════════════════
/* Everything the stage's Excel workbook shows, from this stage's scans:
   summary, shift hours (09:30–18:30 IST), days, who did how many pieces,
   orders with each work order's product and variant, variant totals, and the
   scan log. Same aggregation as Packaging (services/manufacturing/stageReport.js). */
router.get("/:stage/report", ...canRead, async (req, res) => {
  try {
    let window;
    try { window = reportWindow(req.query); }
    catch (e) { return res.status(e.status || 400).json({ success: false, message: e.message }); }
    const companyId = companyOf(req);
    const stage = req.stage.slug;

    const scans = await FinishingScan.find({
      companyId, stage, ...(window.all ? {} : { doneAt: { $gte: window.start, $lt: window.end } }),
    }).select("doneAt doneBy source barcode workOrderId workOrderNumber unitNumber manufacturingOrderId moNumber customerName productName stockItemId variantId variantAttributes")
      .sort({ doneAt: 1 }).lean();

    const woIds = [...new Set(scans.map((s) => String(s.workOrderId)))];
    const wos = woIds.length
      ? await access.findWorkOrders(companyId, { _id: { $in: woIds.map(access.oid) } },
        "workOrderNumber quantity customerRequestId stockItemId stockItemName stockItemReference variantId variantAttributes").lean()
      : [];
    const moIds = [...new Set(wos.map((w) => String(w.customerRequestId || "")).filter(access.isId))];
    const [resolved, mos, overall] = await Promise.all([
      resolveVariantAttributes(wos),
      moIds.length ? CustomerRequest.find({ _id: { $in: moIds.map(access.oid) } }).select("requestId requestType customerInfo.name poProof.poNumber").lean() : [],
      woIds.length ? FinishingScan.aggregate([
        { $match: { stage, workOrderId: { $in: wos.map((w) => w._id) } } },
        { $group: { _id: "$workOrderId", n: { $sum: 1 } } },
      ]) : [],
    ]);
    const woById = new Map(wos.map((w, i) => [String(w._id), { wo: w, variant: variantText(resolved[i]) }]));
    const moById = new Map(mos.map((m) => [String(m._id), {
      moNumber: `MO-${m.requestId}`, customerName: m.customerInfo?.name || "", poNumber: m.poProof?.poNumber || "", requestType: m.requestType || "",
    }]));
    const doneOverall = new Map(overall.map((a) => [String(a._id), a.n]));
    const woTotals = new Map(wos.map((w) => [String(w._id), { quantity: w.quantity || 0, doneOverall: doneOverall.get(String(w._id)) || 0 }]));

    const events = [];
    for (const s of scans) {
      const hit = woById.get(String(s.workOrderId));
      if (!hit) continue; // a work order no longer this company's is not reported
      const o = moById.get(String(hit.wo.customerRequestId || "")) || null;
      const name = s.doneBy?.name || "Unknown";
      events.push({
        at: new Date(s.doneAt),
        personKey: s.doneBy?.userId || `name:${name}`,
        personName: name,
        personEmployeeId: s.doneBy?.employeeId || "",
        qty: 1, units: [s.unitNumber],
        woId: String(s.workOrderId), woNumber: s.workOrderNumber || displayWorkOrderNumber(hit.wo),
        product: s.productName || hit.wo.stockItemName || "", reference: hit.wo.stockItemReference || "", variant: hit.variant,
        moId: hit.wo.customerRequestId ? String(hit.wo.customerRequestId) : null,
        moNumber: o?.moNumber || s.moNumber || "", customerName: o?.customerName || s.customerName || "",
        poNumber: o?.poNumber || "", requestType: o?.requestType || "",
        barcode: s.barcode || "", source: s.source || "",
      });
    }

    const report = buildStageReport({ events, window, woTotals });
    return res.json({
      success: true,
      department: req.stage.name,
      stage,
      doneLabel: req.stage.doneLabel,
      generatedAt: new Date(),
      ...report,
      notes: { inferredVariant: report.variants.some((v) => String(v.variant).endsWith("†")) },
    });
  } catch (err) {
    console.error("Finishing report error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;
