// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingSeasonRoutes.js
//
// CUTTING SEASONS (25 Sep 2026) — mounted inside cuttingMasterRoutes, so the
// full paths are /api/cms/manufacturing/cutting-master/seasons/* and
// /api/cms/manufacturing/cutting-master/find-piece.
//
//   GET    /seasons?status=            the list (closed ones carry their summary)
//   GET    /seasons/open               every draft/active season — what to resume
//   POST   /seasons                    create a draft (no name: it is made from what is typed)
//   GET    /seasons/:id                one season, with the live product tally
//   GET    /seasons/:id/sticker?code=  what a sticker holds, before "use all or a cut piece?"
//   POST   /seasons/:id/raw-items      scan a fabric sticker in (draft only) { code, take? }
//   DELETE /seasons/:id/raw-items/:barcodeId   take one out (draft only)
//   POST   /seasons/:id/start          freeze the fabric list, open a cutting session per sticker
//   POST   /seasons/:id/pieces         scan a cut piece { code } (active only)
//   DELETE /seasons/:id/pieces/:barcode         undo a wrong piece scan (active only)
//   POST   /seasons/:id/close          { remaining: { <barcodeId>: qty } } settle fabric, summarise
//   POST   /seasons/:id/discard        drop a DRAFT that was never started
//   GET    /seasons/:id/report         the season as report rows (CSV/Excel is built by the CMS)
//   GET    /find-piece?barcode=        one garment's journey: cutting first, then finishing, packing
//
// The season is the server's memory of where the cutting master is; the page
// resumes from GET /open. Fabric consumption is written on the sticker's own
// cutting session (Barcode.cuttingSessions), as the old tracker did.
"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const CuttingSeason = require("../../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason");
const { identityRefusal } = require("../../../../services/storePurchase/labelIdentity");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const FinishingScan = require("../../../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const PackingCarton = require("../../../../models/CMS_Models/Manufacturing/Packaging/PackingCarton");
const { displayWorkOrderNumber } = require("../../../../services/manufacturing/workOrderNumber");
const { resolvePhotos, variantText } = require("../../../../services/manufacturing/workOrderPhoto");
const { STAGES, STAGE_KEYS } = require("../../../../services/manufacturing/finishingStages");
const cutting = require("./cuttingAccess");
const logBook = require("../../../../services/manufacturing/cuttingLogBook");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const actorOf = (req) => ({ id: isId(req.user?.id) ? oid(req.user.id) : null, name: str(req.user?.name), employeeId: str(req.user?.employeeId) });
const companyOf = (req) => req.cutting.companyId;
const canRead = [cutting.cuttingDepartment("viewer"), cutting.cuttingCompany];
const canWrite = [cutting.cuttingDepartment("editor"), cutting.cuttingCompany];
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/* ── codes ─────────────────────────────────────────────────────────────── */
/** A Product Marking sticker: `itemid=<24 hex>` in any of its printed forms, or a bare id. */
function parseStickerCode(raw) {
  const s = str(raw);
  if (!s) return null;
  const q = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s;
  for (const part of q.split(/[&#]/)) { const [k, v] = part.split("="); if (v && /^(itemid|rawitem)$/i.test(k)) { const id = decodeURIComponent(v).trim(); return isId(id) && /^[0-9a-f]{24}$/i.test(id) ? id.toLowerCase() : null; } }
  return /^[0-9a-f]{24}$/i.test(s) ? s.toLowerCase() : null;
}
/** WO-<short id>-<unit>, the form the piece labels carry. */
function parsePieceCode(raw) {
  const parts = str(raw).split("-");
  if (parts.length < 3 || parts[0].toUpperCase() !== "WO") return null;
  const unit = parseInt(parts[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  const shortId = parts[1].toLowerCase();
  return { shortId, unit, barcode: `WO-${shortId}-${String(unit).padStart(3, "0")}` };
}
const WO_SELECT = "_id workOrderNumber quantity customerRequestId stockItemId stockItemName stockItemReference variantId variantAttributes salesLineLink";
/** This company's work orders by the short id a barcode carries; a shared short id resolves to null (ambiguous). */
async function workOrderIndex(companyId) {
  const wos = await WorkOrder.find(cutting.workOrderScope(companyId)).select(WO_SELECT).lean();
  const byShort = new Map();
  for (const wo of wos) { const s = String(wo._id).slice(-8).toLowerCase(); byShort.set(s, byShort.has(s) ? null : wo); }
  return byShort;
}
async function resolvePiece(companyId, raw) {
  const p = parsePieceCode(raw);
  if (!p) return { invalid: "Not a piece barcode — expected WO-<id>-<unit>." };
  const index = await workOrderIndex(companyId);
  const wo = index.get(p.shortId);
  if (wo === null) return { ...p, invalid: `Two work orders share the id ${p.shortId} — this barcode cannot be resolved.` };
  if (!wo) return { ...p, invalid: `No work order of this company matches ${p.shortId}.` };
  if (p.unit > (wo.quantity || 0)) return { ...p, invalid: `Piece ${p.unit} is past the ${wo.quantity || 0} ordered on ${displayWorkOrderNumber(wo)}.` };
  return { ...p, wo };
}
async function orderInfo(ids) {
  const clean = [...new Set(ids.filter(Boolean).map(String))].filter(isId);
  if (!clean.length) return new Map();
  const mos = await CustomerRequest.find({ _id: { $in: clean.map(oid) } }).select("requestId customerInfo.name").lean();
  return new Map(mos.map((m) => [String(m._id), { moNumber: `MO-${m.requestId}`, customerName: m.customerInfo?.name || "" }]));
}

/* ── views ─────────────────────────────────────────────────────────────── */
/** Pieces grouped per work order, with product, variant, photo and the count. */
async function tally(season) {
  const counts = new Map();
  for (const p of season.pieces || []) { const k = String(p.workOrderId); counts.set(k, (counts.get(k) || 0) + 1); }
  if (!counts.size) return [];
  const wos = await WorkOrder.find({ _id: { $in: [...counts.keys()].map(oid) } }).select(WO_SELECT).lean();
  const photos = await resolvePhotos(wos);
  const orders = await orderInfo(wos.map((w) => w.customerRequestId));
  return wos.map((wo, i) => { const o = orders.get(String(wo.customerRequestId || "")) || {}; return { workOrderId: wo._id, workOrderNumber: displayWorkOrderNumber(wo), moNumber: o.moNumber || "", customerName: o.customerName || "", productName: wo.stockItemName || "", productReference: wo.stockItemReference || "", variantText: variantText({ attributes: wo.variantAttributes || [] }), photo: photos[i] || null, quantity: wo.quantity || 0, count: counts.get(String(wo._id)) || 0 }; })
    .sort((a, b) => b.count - a.count || a.productName.localeCompare(b.productName));
}
/* A CLOSED season can still be edited for 24 hours after it was closed — its
   report details and its lay — and is final after that (14 Oct 2026, owner:
   "editable for 24h after submission … after it you can't undo it"). */
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const editableUntil = (s) => (s.status === "closed" && s.closedAt ? new Date(new Date(s.closedAt).getTime() + EDIT_WINDOW_MS) : null);
const stillEditable = (s, now = Date.now()) => s.status !== "closed" || (editableUntil(s) && now < editableUntil(s).getTime());
const seasonView = (s, products) => ({
  id: String(s._id), name: s.name, status: s.status, note: s.note || "",
  editableUntil: editableUntil(s), editable: !!stillEditable(s), editWindowHours: EDIT_WINDOW_MS / 3600000,
  createdAt: s.createdAt, createdBy: s.createdBy || {}, startedAt: s.startedAt, startedBy: s.startedBy || {}, closedAt: s.closedAt, closedBy: s.closedBy || {},
  rawItems: (s.rawItems || []).map((r) => ({ ...r, barcodeId: String(r.barcodeId), rawItemId: r.rawItemId ? String(r.rawItemId) : null, variantId: r.variantId ? String(r.variantId) : null, sessionId: r.sessionId ? String(r.sessionId) : null })),
  rawItemCount: (s.rawItems || []).length,
  piecesCount: s.status === "closed" ? s.piecesCount : (s.pieces || []).length,
  recentPieces: [...(s.pieces || [])].slice(-25).reverse().map((p) => ({ barcode: p.barcode, workOrderId: String(p.workOrderId), unitNumber: p.unitNumber, scannedAt: p.scannedAt, scannedBy: p.scannedBy || {} })),
  products: products || s.products || [],
  fabric: (s.rawItems || []).reduce((m, r) => { const u = r.unit || "?"; m[u] = Math.round(((m[u] || 0) + (r.quantityAtScan || 0)) * 10000) / 10000; return m; }, {}),
  fabricUsed: (s.rawItems || []).reduce((m, r) => { if (r.usedQty == null) return m; const u = r.unit || "?"; m[u] = Math.round(((m[u] || 0) + r.usedQty) * 10000) / 10000; return m; }, {}),
  /* The cutting log book (14 Oct 2026): the report header, every lay with
     its worked-out columns, and the daily report's summary. */
  header: { buyerName: s.header?.buyerName || "", poNo: s.header?.poNo || "", styleNo: s.header?.styleNo || "", colour: s.header?.colour || "", date: s.header?.date || null },
  lays: (s.lays || []).map(layView),
  log: logBook.summarize(s.lays || []),
});
function layView(l) {
  const { _id, createdBy, updatedBy, createdAt, updatedAt, ...typed } = l;
  return { id: String(_id), ...typed, ...logBook.inFeet(l), ratio: { ...Object.fromEntries(logBook.SIZES.map((k) => [k, Number(l.ratio?.[k]) || 0])) }, ...logBook.computeLay(l), createdBy: createdBy || {}, updatedBy: updatedBy || {}, createdAt, updatedAt };
}
async function loadSeason(req, res, { forWrite = false } = {}) {
  if (!isId(req.params.id)) { fail(res, 404, "Season not found"); return null; }
  const q = CuttingSeason.findOne({ _id: oid(req.params.id), companyId: companyOf(req), deletedAt: null });
  const s = forWrite ? await q : await q.lean();
  if (!s) { fail(res, 404, "Season not found"); return null; }
  return s;
}

/** Why this sticker cannot go into season `s`, in words; "" when it can. */
async function stickerRefusal(companyId, s, b) {
  if (!b) return "No raw-item sticker matches that code.";
  if ((b.quantity || 0) <= 0) return `${b.rawItemName || "This sticker"} has no quantity left.`;
  /* A label printed while a delivery was being counted is a real code for
     material GRAV has not received. It must not be cut. */
  const idRefusal = identityRefusal(b);
  if (idRefusal) return idRefusal.message;
  if (!(await RawItem.exists({ _id: b.rawItem }))) return "The sticker's raw item no longer exists.";
  const other = await CuttingSeason.findOne({ companyId, _id: { $ne: s._id }, status: { $ne: "closed" }, "rawItems.barcodeId": b._id }).select("name").lean();
  if (other) return `Already in the open season "${other.name}".`;
  if ((b.cuttingSessions || []).some((c) => !c.closedAt)) return `${b.rawItemName} has a cutting session still open from the old tracker. Close it there first.`;
  return "";
}
/* HOW MUCH OF THE ROLL (14 Oct 2026, owner: "the fabrics can be 50 or 100
   metre … it should ask either use all or a cut piece"). `take` is absent or
   "all" for the whole sticker, else the cut piece in the sticker's own unit.
   A piece equal to the whole roll is the whole roll. */
function portionOf(b, take) {
  const held = b.quantity || 0;
  const all = { ok: true, portion: "all", quantityAtScan: held, stickerQty: held };
  if (take === undefined || take === null || take === "" || take === "all") return all;
  const q = Number(take);
  if (!Number.isFinite(q) || q <= 0) return { ok: false, reason: "The cut piece must be more than 0." };
  if (q > held + 1e-6) return { ok: false, reason: `The cut piece (${q} ${b.unit || ""}) is more than the ${held} ${b.unit || ""} on the sticker.`.replace(/ +\)/g, ")") };
  if (Math.abs(q - held) < 1e-6) return all;
  return { ok: true, portion: "part", quantityAtScan: Math.round(q * 10000) / 10000, stickerQty: held };
}
const rawRow = (b, p, at, by) => ({ barcodeId: b._id, rawItemId: b.rawItem || null, rawItemName: b.rawItemName || "", rawItemSku: b.rawItemSku || "", variantId: b.variantId || null, variantText: (b.variantCombination || []).join(" · "), unit: b.unit || "", quantityAtScan: p.quantityAtScan, portion: p.portion, stickerQty: p.stickerQty, scannedAt: at, scannedBy: by });

/** A device clock is a hint: nothing from the future, nothing older than 30 days. */
function plausibleAt(value, fallback) {
  const t = value ? new Date(value) : null;
  if (!t || Number.isNaN(t.getTime())) return fallback;
  const ms = t.getTime();
  if (ms > fallback.getTime() + 5 * 60 * 1000) return fallback;
  if (ms < fallback.getTime() - 30 * 24 * 60 * 60 * 1000) return fallback;
  return t;
}

/* ── reachability (with a session) — what the offline queue pings ─────── */
router.get("/seasons/ping", (_req, res) => res.json({ success: true, at: new Date().toISOString() }));

/* ── seasons ───────────────────────────────────────────────────────────── */
router.get("/seasons", ...canRead, async (req, res) => {
  try {
    const f = { companyId: companyOf(req), deletedAt: null };
    if (["draft", "active", "closed"].includes(req.query.status)) f.status = req.query.status;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await CuttingSeason.find(f).sort({ createdAt: -1 }).limit(limit).select("-pieces").lean();
    return res.json({ success: true, seasons: rows.map((s) => ({ ...seasonView(s), piecesCount: s.status === "closed" ? s.piecesCount : undefined, recentPieces: undefined, lays: undefined })), openCount: await CuttingSeason.countDocuments({ companyId: companyOf(req), status: { $ne: "closed" } }) });
  } catch (err) { console.error("[cutting-seasons] list:", err); return fail(res, 500, err.message); }
});
/* live counts for open seasons are cheap to add here: the list above strips pieces */
router.get("/seasons/open", ...canRead, async (req, res) => {
  try {
    const rows = await CuttingSeason.find({ companyId: companyOf(req), status: { $ne: "closed" }, deletedAt: null }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, seasons: rows.map((s) => ({ ...seasonView(s), lays: undefined })) });
  } catch (err) { console.error("[cutting-seasons] open:", err); return fail(res, 500, err.message); }
});
/* The orders a log book's "PO No" may name (14 Oct 2026, owner: "a searchable
   dropdown so all the PO numbers are there suggesting"). Every order with a
   work order in this company, newest first, with its customer PO (wherever
   Sales recorded it — services/customerRequestPo), buyer, MO number and the
   styles cut for it. An order with no PO recorded is listed too, marked, so
   it can still be found by MO number or buyer; the field stays free text. */
router.get("/seasons/po-options", ...canRead, async (req, res) => {
  try {
    const { PO_SELECT, poOf } = require("../../../../services/customerRequestPo");
    const wos = await WorkOrder.find(cutting.workOrderScope(companyOf(req))).select("customerRequestId stockItemName stockItemReference").lean();
    const styles = new Map();
    for (const w of wos) {
      if (!w.customerRequestId) continue;
      const k = String(w.customerRequestId);
      if (!styles.has(k)) styles.set(k, new Set());
      const style = str(w.stockItemReference) || str(w.stockItemName);
      if (style) styles.get(k).add(style);
    }
    const ids = [...styles.keys()].filter(isId).map(oid);
    const orders = ids.length
      ? await CustomerRequest.find({ _id: { $in: ids } }).select(`${PO_SELECT} requestId customerInfo.name createdAt`).sort({ createdAt: -1 }).limit(500).lean()
      : [];
    const options = orders.map((o) => ({
      orderId: String(o._id),
      poNo: poOf(o).poNumber,
      moNumber: o.requestId ? `MO-${o.requestId}` : "",
      buyerName: o.customerInfo?.name || "",
      styles: [...(styles.get(String(o._id)) || [])].slice(0, 20),
    }));
    return res.json({ success: true, options, withoutPo: options.filter((o) => !o.poNo).length });
  } catch (err) { console.error("[cutting-seasons] po-options:", err); return fail(res, 500, err.message); }
});
/* THE REPORT OVER A DATE RANGE (14 Oct 2026, owner): every season whose lay
   falls between `from` and `to` (inclusive, calendar days), one row each, with
   the daily report's summary over all of them — what the page previews and
   the workbook writes. Open and closed seasons alike; a season with no lay
   yet has nothing to report and is left out. */
router.get("/seasons/report-range", ...canRead, async (req, res) => {
  try {
    const from = logBook.dayFrom(req.query.from);
    const to = logBook.dayFrom(req.query.to);
    if (!from || !to) return fail(res, 400, "Choose a From and a To date (YYYY-MM-DD).");
    if (to < from) return fail(res, 400, "The To date is before the From date.");
    if ((to - from) / 86400000 > 366) return fail(res, 400, "Choose a range of a year or less.");
    const end = new Date(to.getTime() + 86400000);
    const rows = await CuttingSeason.find({ companyId: companyOf(req), deletedAt: null, "lays.date": { $gte: from, $lt: end } })
      .select("name status header lays createdAt createdBy closedAt")
      .lean();
    const lays = [];
    for (const s of rows) {
      for (const l of s.lays || []) {
        if (!(l.date >= from && l.date < end)) continue;
        lays.push({
          ...layView(l),
          seasonId: String(s._id), seasonName: s.name, seasonStatus: s.status,
          buyerName: s.header?.buyerName || "", poNo: s.header?.poNo || "",
        });
      }
    }
    lays.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.seasonName).localeCompare(String(b.seasonName)));
    const uniq = (k) => [...new Set(lays.map((l) => String(l[k] || "").trim()).filter(Boolean))];
    return res.json({
      success: true,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      seasons: rows.length,
      header: { buyerName: uniq("buyerName").join(", "), poNo: uniq("poNo").join(", "), styleNo: uniq("styleNo").join(", "), colour: uniq("colour").join(", ") },
      lays,
      log: logBook.summarize(lays),
    });
  } catch (err) { console.error("[cutting-seasons] report-range:", err); return fail(res, 500, err.message); }
});
router.post("/seasons", ...canWrite, async (req, res) => {
  try {
    /* No name is asked (14 Oct 2026, owner): the season is named from its
       report details and lay, on every save (CuttingSeason's nameAuto hook). */
    const name = str(req.body?.name);
    if (!name) {
      const s = await CuttingSeason.create({ companyId: companyOf(req), name: "New season", nameAuto: true, createdBy: actorOf(req), note: str(req.body?.note).slice(0, 1000) });
      return res.status(201).json({ success: true, season: seasonView(s.toObject()) });
    }
    if (name.length < 2) return fail(res, 400, "Give the season a name (at least 2 characters).");
    if (await CuttingSeason.exists({ companyId: companyOf(req), name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), status: { $ne: "closed" } })) return fail(res, 409, `A season called "${name}" is already open. Resume it or choose another name.`);
    const s = await CuttingSeason.create({ companyId: companyOf(req), name, createdBy: actorOf(req), note: str(req.body?.note).slice(0, 1000) });
    return res.status(201).json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] create:", err); return fail(res, 500, err.message); }
});
router.get("/seasons/:id", ...canRead, async (req, res) => {
  try {
    const s = await loadSeason(req, res); if (!s) return;
    const products = s.status === "closed" ? s.products : await tally(s);
    return res.json({ success: true, season: seasonView(s, products) });
  } catch (err) { console.error("[cutting-seasons] get:", err); return fail(res, 500, err.message); }
});

/* ── the cutting log book (14 Oct 2026) ─────────────────────────────────
   Typed, not scanned: the report header and one row per lay. Open while the
   season is not closed, and for 24 hours after it was closed; final after. */
const editable = (s, res) => {
  if (stillEditable(s)) return true;
  const until = editableUntil(s);
  fail(res, 409, `This season was closed${until ? ` and could be edited until ${until.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""} — it is final now and can no longer be changed.`, { code: "SEASON_FINAL" });
  return false;
};
router.put("/seasons/:id/header", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (!editable(s, res)) return;
    s.header = logBook.normaliseHeader(req.body || {});
    /* the lay is dated by its season, so a changed report date moves it too */
    const day = logBook.seasonDay(s);
    if (day) for (const l of s.lays || []) l.date = day;
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] header:", err); return fail(res, 500, err.message); }
});
router.post("/seasons/:id/lays", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (!editable(s, res)) return;
    /* ONE LAY A SEASON (14 Oct 2026, owner): a season is one lay. The second
       is refused — edit the one there is — and its date is the season's. */
    if ((s.lays || []).length) return fail(res, 409, "This season already has its lay. Edit it, or create a new season for the next lay.", { code: "ONE_LAY_PER_SEASON", layId: String(s.lays[0]._id) });
    const { lay, error } = logBook.normaliseLay({ ...(req.body || {}), date: logBook.seasonDay(s) || req.body?.date });
    if (error) return fail(res, 400, error);
    s.lays.push({ ...lay, createdBy: actorOf(req), updatedBy: actorOf(req) });
    await s.save();
    const saved = s.toObject();
    return res.status(201).json({ success: true, lay: layView(saved.lays[saved.lays.length - 1]), season: seasonView(saved) });
  } catch (err) { console.error("[cutting-seasons] lay add:", err); return fail(res, 500, err.message); }
});
router.put("/seasons/:id/lays/:layId", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (!editable(s, res)) return;
    const row = isId(req.params.layId) ? s.lays.id(req.params.layId) : null;
    if (!row) return fail(res, 404, "That lay is not in this season.");
    const { lay, error } = logBook.normaliseLay({ ...(req.body || {}), date: logBook.seasonDay(s) || row.date });
    if (error) return fail(res, 400, error);
    row.set({ ...lay, updatedBy: actorOf(req) });
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] lay edit:", err); return fail(res, 500, err.message); }
});
router.delete("/seasons/:id/lays/:layId", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (!editable(s, res)) return;
    if (s.status === "closed") return fail(res, 409, "A closed season keeps its lay — correct it instead of deleting it.");
    const row = isId(req.params.layId) ? s.lays.id(req.params.layId) : null;
    if (!row) return fail(res, 404, "That lay is not in this season.");
    row.deleteOne();
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] lay delete:", err); return fail(res, 500, err.message); }
});

/* fabric in (draft only) */
router.post("/seasons/:id/raw-items", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status !== "draft") return fail(res, 409, s.status === "active" ? "The season has started — its fabric list is frozen. Close it and create a new season to add more." : "This season is closed.");
    const id = parseStickerCode(req.body?.code);
    if (!id) return fail(res, 400, "That is not a raw-item sticker (expected itemid=<id>).", { kind: parsePieceCode(req.body?.code) ? "piece" : "unknown" });
    if (s.rawItems.some((r) => String(r.barcodeId) === id)) return res.json({ success: true, duplicate: true, season: seasonView(s.toObject()), message: "That sticker is already in this season." });
    const b = await Barcode.findById(id).lean();
    if (!b) return fail(res, 404, "No raw-item sticker matches that code.");
    if ((b.quantity || 0) <= 0) return fail(res, 400, `${b.rawItemName || "This sticker"} has no quantity left.`);
    /* A label printed while a delivery was being counted is a real code for
       material GRAV has not received. It must not be cut. */
    const idRefusal = identityRefusal(b);
    if (idRefusal) return fail(res, 400, idRefusal.message, { reason: idRefusal.reason });
    if (!(await RawItem.exists({ _id: b.rawItem }))) return fail(res, 404, "The sticker's raw item no longer exists.");
    const other = await CuttingSeason.findOne({ companyId: companyOf(req), _id: { $ne: s._id }, status: { $ne: "closed" }, "rawItems.barcodeId": oid(id) }).select("name").lean();
    if (other) return fail(res, 409, `That sticker is already in the open season "${other.name}".`);
    if ((b.cuttingSessions || []).some((c) => !c.closedAt)) return fail(res, 409, `${b.rawItemName} has a cutting session still open from the old tracker. Close it there first.`);
    const p = portionOf(b, req.body?.take);
    if (!p.ok) return fail(res, 400, p.reason);
    s.rawItems.push(rawRow(b, p, new Date(), actorOf(req)));
    await s.save();
    return res.json({ success: true, duplicate: false, added: s.rawItems[s.rawItems.length - 1], season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] raw-item:", err); return fail(res, 500, err.message); }
});
/* What a scanned sticker holds, so the page can ask "use all, or a cut
   piece?" with the roll's name and metres in front of the person. Reads
   only; nothing is added until the answer is sent. */
router.get("/seasons/:id/sticker", ...canRead, async (req, res) => {
  try {
    const s = await loadSeason(req, res); if (!s) return;
    const id = parseStickerCode(req.query.code);
    if (!id) return fail(res, 400, "That is not a raw-item sticker (expected itemid=<id>).");
    const b = await Barcode.findById(id).lean();
    const already = (s.rawItems || []).some((r) => String(r.barcodeId) === id);
    const refusal = already ? "That sticker is already in this season." : await stickerRefusal(companyOf(req), s, b);
    return res.json({ success: true, already, refusal, sticker: b ? { barcodeId: id, rawItemName: b.rawItemName || "", rawItemSku: b.rawItemSku || "", variantText: (b.variantCombination || []).join(" · "), unit: b.unit || "", quantity: b.quantity || 0 } : null });
  } catch (err) { console.error("[cutting-seasons] sticker:", err); return fail(res, 500, err.message); }
});
router.delete("/seasons/:id/raw-items/:barcodeId", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status !== "draft") return fail(res, 409, "Fabric can only be removed before the season starts.");
    const before = s.rawItems.length;
    s.rawItems = s.rawItems.filter((r) => String(r.barcodeId) !== String(req.params.barcodeId));
    if (s.rawItems.length === before) return fail(res, 404, "That sticker is not in this season.");
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] raw-item remove:", err); return fail(res, 500, err.message); }
});

/* start: freeze the list, open one cutting session per sticker */
router.post("/seasons/:id/start", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status === "active") return res.json({ success: true, season: seasonView(s.toObject()), already: true });
    if (s.status !== "draft") return fail(res, 409, "This season is closed.");
    if (!s.rawItems.length) return fail(res, 400, "Scan at least one raw-item sticker before starting.");
    for (const r of s.rawItems) {
      const b = await Barcode.findById(r.barcodeId);
      if (!b) return fail(res, 404, `${r.rawItemName}'s sticker no longer exists.`);
      if (r.portion === "part" && (b.quantity || 0) + 1e-6 < r.quantityAtScan) return fail(res, 409, `${r.rawItemName}: the sticker now holds ${b.quantity || 0} ${r.unit}, less than the ${r.quantityAtScan} ${r.unit} cut piece taken. Remove it and scan it again.`);
      let session = (b.cuttingSessions || []).find((c) => !c.closedAt);
      if (!session) { b.cuttingSessions.push({ startQty: b.quantity || 0, endQty: null, scannedPieces: [], startedAt: new Date(), closedAt: null }); await b.save(); session = b.cuttingSessions[b.cuttingSessions.length - 1]; }
      r.sessionId = session._id; r.startQty = session.startQty;
    }
    s.status = "active"; s.startedAt = new Date(); s.startedBy = actorOf(req);
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject(), []) });
  } catch (err) { console.error("[cutting-seasons] start:", err); return fail(res, 500, err.message); }
});

/* pieces (active only) */
router.post("/seasons/:id/pieces", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status !== "active") return fail(res, 409, s.status === "draft" ? "Start the season before scanning pieces." : "This season is closed.");
    if (parseStickerCode(req.body?.code) && !parsePieceCode(req.body?.code)) return fail(res, 400, "That is a raw-item sticker. Scan the cut piece's barcode here.", { kind: "sticker" });
    const r = await resolvePiece(companyOf(req), req.body?.code);
    if (r.invalid) return fail(res, 400, r.invalid, { kind: "invalid", barcode: r.barcode || str(req.body?.code) });
    if (s.pieces.some((p) => String(p.workOrderId) === String(r.wo._id) && p.unitNumber === r.unit)) return res.json({ success: true, duplicate: true, barcode: r.barcode, message: `${r.barcode} was already scanned in this season.`, piecesCount: s.pieces.length });
    const elsewhere = await CuttingSeason.findOne({ companyId: companyOf(req), _id: { $ne: s._id }, pieces: { $elemMatch: { workOrderId: r.wo._id, unitNumber: r.unit } } }).select("name status").lean();
    s.pieces.push({ barcode: r.barcode, workOrderId: r.wo._id, unitNumber: r.unit, scannedAt: new Date(), scannedBy: actorOf(req) });
    await s.save();
    const [photo] = await resolvePhotos([r.wo]);
    const count = s.pieces.filter((p) => String(p.workOrderId) === String(r.wo._id)).length;
    return res.json({ success: true, duplicate: false, barcode: r.barcode, piecesCount: s.pieces.length, piece: { barcode: r.barcode, unitNumber: r.unit, workOrderId: String(r.wo._id), workOrderNumber: displayWorkOrderNumber(r.wo), productName: r.wo.stockItemName || "", variantText: variantText({ attributes: r.wo.variantAttributes || [] }), photo: photo || null, quantity: r.wo.quantity || 0, countInSeason: count }, warning: elsewhere ? `${r.barcode} was also scanned in season "${elsewhere.name}" (${elsewhere.status}).` : "" });
  } catch (err) { console.error("[cutting-seasons] piece:", err); return fail(res, 500, err.message); }
});
router.delete("/seasons/:id/pieces/:barcode", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status !== "active") return fail(res, 409, "Pieces can only be undone while the season is active.");
    const p = parsePieceCode(req.params.barcode);
    const before = s.pieces.length;
    s.pieces = s.pieces.filter((x) => x.barcode !== (p ? p.barcode : str(req.params.barcode)));
    if (s.pieces.length === before) return fail(res, 404, "That piece is not in this season.");
    await s.save();
    return res.json({ success: true, piecesCount: s.pieces.length });
  } catch (err) { console.error("[cutting-seasons] piece undo:", err); return fail(res, 500, err.message); }
});

/* ── batches: what the device's offline queue sends when it can ─────────
   Both are idempotent per code — a batch received twice settles every row
   as "already" the second time — and both answer every input by name, so
   the device can settle each scan and never has to guess. `at` is the
   moment the device read the code, bounds-checked like the finishing scans. */
router.post("/seasons/:id/raw-items/batch", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    const scans = Array.isArray(req.body?.scans) ? req.body.scans.slice(0, 500) : [];
    const results = [];
    if (s.status !== "draft") { for (const sc of scans) results.push({ input: str(sc?.code ?? sc), status: "invalid", reason: s.status === "active" ? "The season has started — its fabric list is frozen." : "This season is closed." }); return res.json({ success: true, results, counts: count(results), season: seasonView(s.toObject()) }); }
    const now = new Date();
    const seenIds = new Set();
    for (const sc of scans) {
      const input = str(sc?.code ?? sc);
      const id = parseStickerCode(input);
      if (!id) { results.push({ input, status: "invalid", reason: parsePieceCode(input) ? "That is a piece barcode — pieces come after Start." : "Not a raw-item sticker (expected itemid=<id>)." }); continue; }
      if (seenIds.has(id) || s.rawItems.some((r) => String(r.barcodeId) === id)) { results.push({ input, status: "already", barcodeId: id }); continue; }
      const b = await Barcode.findById(id).lean();
      const refusal = await stickerRefusal(companyOf(req), s, b);
      if (refusal) { results.push({ input, status: "invalid", reason: refusal }); continue; }
      const p = portionOf(b, sc?.take);
      if (!p.ok) { results.push({ input, status: "invalid", reason: p.reason }); continue; }
      const row = rawRow(b, p, plausibleAt(sc?.at, now), actorOf(req));
      s.rawItems.push(row); seenIds.add(id);
      results.push({ input, status: "saved", barcodeId: id, added: { rawItemName: row.rawItemName, variantText: row.variantText, quantityAtScan: row.quantityAtScan, unit: row.unit, portion: row.portion, stickerQty: row.stickerQty } });
    }
    if (results.some((r) => r.status === "saved")) await s.save();
    return res.json({ success: true, results, counts: count(results), season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] raw-items batch:", err); return fail(res, 500, err.message); }
});
router.post("/seasons/:id/pieces/batch", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    const scans = Array.isArray(req.body?.scans) ? req.body.scans.slice(0, 1000) : [];
    const results = [];
    if (s.status !== "active") { for (const sc of scans) results.push({ input: str(sc?.barcode ?? sc?.code ?? sc), status: "invalid", reason: s.status === "draft" ? "Start the season before scanning pieces." : "This season is closed." }); return res.json({ success: true, results, counts: count(results), piecesCount: s.pieces.length, products: s.status === "closed" ? s.products : await tally(s) }); }
    const now = new Date();
    const index = scans.length ? await workOrderIndex(companyOf(req)) : new Map();
    const have = new Set(s.pieces.map((p) => `${p.workOrderId}|${p.unitNumber}`));
    const touched = new Map();
    for (const sc of scans) {
      const input = str(sc?.barcode ?? sc?.code ?? sc);
      if (parseStickerCode(input) && !parsePieceCode(input)) { results.push({ input, status: "invalid", reason: "That is a raw-item sticker, not a cut piece." }); continue; }
      const p = parsePieceCode(input);
      if (!p) { results.push({ input, status: "invalid", reason: "Not a piece barcode — expected WO-<id>-<unit>." }); continue; }
      const wo = index.get(p.shortId);
      if (wo === null) { results.push({ input, barcode: p.barcode, status: "invalid", reason: `Two work orders share the id ${p.shortId}.` }); continue; }
      if (!wo) { results.push({ input, barcode: p.barcode, status: "invalid", reason: `No work order of this company matches ${p.shortId}.` }); continue; }
      if (p.unit > (wo.quantity || 0)) { results.push({ input, barcode: p.barcode, status: "invalid", reason: `Piece ${p.unit} is past the ${wo.quantity || 0} ordered on ${displayWorkOrderNumber(wo)}.` }); continue; }
      const k = `${wo._id}|${p.unit}`;
      if (have.has(k)) { results.push({ input, barcode: p.barcode, status: "already", workOrderId: String(wo._id) }); continue; }
      have.add(k); touched.set(String(wo._id), wo);
      s.pieces.push({ barcode: p.barcode, workOrderId: wo._id, unitNumber: p.unit, scannedAt: plausibleAt(sc?.at, now), scannedBy: actorOf(req) });
      results.push({ input, barcode: p.barcode, status: "saved", workOrderId: String(wo._id), productName: wo.stockItemName || "", variantText: variantText({ attributes: wo.variantAttributes || [] }), workOrderNumber: displayWorkOrderNumber(wo) });
    }
    if (results.some((r) => r.status === "saved")) await s.save();
    return res.json({ success: true, results, counts: count(results), piecesCount: s.pieces.length, products: await tally(s) });
  } catch (err) { console.error("[cutting-seasons] pieces batch:", err); return fail(res, 500, err.message); }
});
const count = (results) => results.reduce((c, r) => { c[r.status] = (c[r.status] || 0) + 1; return c; }, { saved: 0, already: 0, invalid: 0 });

/* close: settle fabric on each sticker's session, summarise pieces */
router.post("/seasons/:id/close", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status === "closed") return res.json({ success: true, already: true, season: seasonView(s) });
    /* A log-book season has no Start: it closes from draft once it holds a
       lay. A scanned season (before 14 Oct 2026) still closes from active. */
    if (s.status === "draft" && !(s.lays || []).length) return fail(res, 409, "Add at least one lay before closing the season.");
    const remaining = req.body?.remaining && typeof req.body.remaining === "object" ? req.body.remaining : {};
    for (const r of s.rawItems) {
      const raw = remaining[String(r.barcodeId)];
      const rem = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(rem) || rem < 0) return fail(res, 400, `Remaining quantity for ${r.rawItemName} must be a non-negative number.`);
      /* a cut piece's leftover is measured against the piece, not the roll */
      const cap = r.portion === "part" ? r.quantityAtScan : r.startQty;
      if (cap != null && rem > cap + 1e-6) return fail(res, 400, `${r.rawItemName}: remaining ${rem} ${r.unit} is more than the ${cap} ${r.unit} ${r.portion === "part" ? "cut piece taken" : "it started with"}.`);
    }
    const pieceCodes = s.pieces.map((p) => p.barcode);
    for (const r of s.rawItems) {
      const b = await Barcode.findById(r.barcodeId);
      if (!b) continue;
      const session = r.sessionId ? b.cuttingSessions.id(r.sessionId) : null;
      const raw = remaining[String(r.barcodeId)];
      const rem = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
      if (session && !session.closedAt) {
        const have = new Set(session.scannedPieces || []);
        for (const c of pieceCodes) if (!have.has(c)) { session.scannedPieces.push(c); have.add(c); }
        /* All: what is left on the roll is what was typed. A cut piece: only
           what was used of the piece comes off the roll; the rest of the roll
           never left the store, and the piece's leftover goes back on it. */
        const used = r.portion === "part" ? Math.max(0, (r.quantityAtScan || 0) - rem) : (session.startQty || 0) - rem;
        const onRoll = Math.round(((session.startQty || 0) - used) * 10000) / 10000;
        session.endQty = onRoll; session.closedAt = new Date(); b.quantity = onRoll;
        await b.save();
        r.endQty = rem; r.usedQty = Math.round(used * 10000) / 10000;
      } else if (session) { r.endQty = session.endQty; r.usedQty = Math.round(((session.startQty || 0) - (session.endQty || 0)) * 10000) / 10000; }
    }
    s.products = await tally(s);
    s.piecesCount = s.pieces.length;
    s.status = "closed"; s.closedAt = new Date(); s.closedBy = actorOf(req); s.note = str(req.body?.note || s.note).slice(0, 1000);
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] close:", err); return fail(res, 500, err.message); }
});
/* Remove a season (15 Oct 2026, owner): open, or closed and still inside
   its 24 hours. A season scanned before the log book moved fabric on its
   stickers, so it is not removable here. The season is marked, not erased. */
router.delete("/seasons/:id", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if ((s.rawItems || []).length || (s.pieces || []).length)
      return fail(res, 409, "This season was scanned before the log book and moved fabric on its stickers — it cannot be removed.");
    if (!editable(s, res)) return;
    s.deletedAt = new Date();
    s.deletedBy = actorOf(req);
    await s.save();
    return res.json({ success: true });
  } catch (err) { console.error("[cutting-seasons] remove:", err); return fail(res, 500, err.message); }
});
router.post("/seasons/:id/discard", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status !== "draft") return fail(res, 409, "Only a season that has not started can be discarded. Close it instead.");
    if ((s.lays || []).length) return fail(res, 409, `This season has ${s.lays.length} lay${s.lays.length === 1 ? "" : "s"} in its log book. Delete them first, or close the season.`);
    await s.deleteOne();
    return res.json({ success: true });
  } catch (err) { console.error("[cutting-seasons] discard:", err); return fail(res, 500, err.message); }
});
/* report rows: the CMS lays them out (CSV / Excel) */
router.get("/seasons/:id/report", ...canRead, async (req, res) => {
  try {
    const s = await loadSeason(req, res); if (!s) return;
    const products = s.status === "closed" ? s.products : await tally(s);
    const byWo = new Map(products.map((p) => [String(p.workOrderId), p]));
    return res.json({ success: true, season: seasonView(s, products), rows: { rawItems: s.rawItems, products, pieces: (s.pieces || []).map((p) => { const pr = byWo.get(String(p.workOrderId)) || {}; return { barcode: p.barcode, workOrderNumber: pr.workOrderNumber || "", productName: pr.productName || "", variantText: pr.variantText || "", unitNumber: p.unitNumber, scannedAt: p.scannedAt, scannedBy: p.scannedBy?.name || "" }; }) } });
  } catch (err) { console.error("[cutting-seasons] report:", err); return fail(res, 500, err.message); }
});

/* ── find piece: cutting first, then the finishing stages and packing ──── */
router.get("/find-piece", ...canRead, async (req, res) => {
  try {
    const raw = str(req.query.barcode);
    if (!raw) return fail(res, 400, "barcode is required");
    const r = await resolvePiece(companyOf(req), raw);
    if (r.invalid) return res.json({ success: true, recognised: false, barcode: r.barcode || raw, reason: r.invalid });
    const [photo] = await resolvePhotos([r.wo]);
    const orders = await orderInfo([r.wo.customerRequestId]);
    const [season, scans, carton] = await Promise.all([
      CuttingSeason.findOne({ companyId: companyOf(req), pieces: { $elemMatch: { workOrderId: r.wo._id, unitNumber: r.unit } } }).select("name status pieces.$ startedAt").lean(),
      FinishingScan.find({ workOrderId: r.wo._id, unitNumber: r.unit }).select("stage doneAt doneBy source recordedAt").lean(),
      PackingCarton.findOne({ companyId: companyOf(req), lines: { $elemMatch: { workOrderId: r.wo._id, unitNumbers: r.unit } } }).select("cartonNumber status packedAt packedBy additions dispatchedAt").lean(),
    ]);
    const byStage = new Map(scans.map((x) => [x.stage, x]));
    const stageView = (k) => { const x = byStage.get(k); return x ? { done: true, at: x.doneAt, recordedAt: x.recordedAt, by: x.doneBy, source: x.source } : { done: false }; };
    let packing = { packed: false };
    if (carton) { const session = (carton.additions || []).find((a) => (a.items || []).some((it) => String(it.workOrderId) === String(r.wo._id) && (it.unitNumbers || []).includes(r.unit))); packing = { packed: true, cartonNumber: carton.cartonNumber, status: carton.status, at: session?.at || carton.packedAt, by: session?.packedBy || carton.packedBy, dispatchedAt: carton.dispatchedAt }; }
    const sp = season?.pieces?.[0];
    const cuttingStep = sp ? { done: true, at: sp.scannedAt, by: sp.scannedBy, source: `season "${season.name}"`, seasonId: String(season._id), seasonName: season.name } : { done: false };
    return res.json({
      success: true, recognised: true, stage: "cutting",
      piece: { barcode: r.barcode, input: raw, unit: r.unit, workOrder: { _id: r.wo._id, workOrderNumber: displayWorkOrderNumber(r.wo), shortId: r.shortId, quantity: r.wo.quantity || 0, productName: r.wo.stockItemName || "", productReference: r.wo.stockItemReference || "", variantAttributes: r.wo.variantAttributes || [], productImage: photo || null }, order: orders.get(String(r.wo.customerRequestId || "")) || null },
      stages: { cutting: cuttingStep, ...Object.fromEntries(STAGE_KEYS.map((k) => [k, stageView(k)])), packing },
      names: { cutting: "Cut", ...Object.fromEntries(STAGE_KEYS.map((k) => [k, STAGES[k].doneLabel])) },
      order: ["cutting", ...STAGE_KEYS, "packing"],
    });
  } catch (err) { console.error("[cutting-seasons] find-piece:", err); return fail(res, 500, err.message); }
});

module.exports = router;
