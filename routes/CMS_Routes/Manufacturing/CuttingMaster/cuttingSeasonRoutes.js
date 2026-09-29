// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingSeasonRoutes.js
//
// CUTTING SEASONS (25 Sep 2026) — mounted inside cuttingMasterRoutes, so the
// full paths are /api/cms/manufacturing/cutting-master/seasons/* and
// /api/cms/manufacturing/cutting-master/find-piece.
//
//   GET    /seasons?status=            the list (closed ones carry their summary)
//   GET    /seasons/open               every draft/active season — what to resume
//   POST   /seasons                    create a draft { name }
//   GET    /seasons/:id                one season, with the live product tally
//   POST   /seasons/:id/raw-items      scan a fabric sticker in (draft only) { code }
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
const seasonView = (s, products) => ({
  id: String(s._id), name: s.name, status: s.status, note: s.note || "",
  createdAt: s.createdAt, createdBy: s.createdBy || {}, startedAt: s.startedAt, startedBy: s.startedBy || {}, closedAt: s.closedAt, closedBy: s.closedBy || {},
  rawItems: (s.rawItems || []).map((r) => ({ ...r, barcodeId: String(r.barcodeId), rawItemId: r.rawItemId ? String(r.rawItemId) : null, variantId: r.variantId ? String(r.variantId) : null, sessionId: r.sessionId ? String(r.sessionId) : null })),
  rawItemCount: (s.rawItems || []).length,
  piecesCount: s.status === "closed" ? s.piecesCount : (s.pieces || []).length,
  recentPieces: [...(s.pieces || [])].slice(-25).reverse().map((p) => ({ barcode: p.barcode, workOrderId: String(p.workOrderId), unitNumber: p.unitNumber, scannedAt: p.scannedAt, scannedBy: p.scannedBy || {} })),
  products: products || s.products || [],
  fabric: (s.rawItems || []).reduce((m, r) => { const u = r.unit || "?"; m[u] = Math.round(((m[u] || 0) + (r.quantityAtScan || 0)) * 10000) / 10000; return m; }, {}),
  fabricUsed: (s.rawItems || []).reduce((m, r) => { if (r.usedQty == null) return m; const u = r.unit || "?"; m[u] = Math.round(((m[u] || 0) + r.usedQty) * 10000) / 10000; return m; }, {}),
});
async function loadSeason(req, res, { forWrite = false } = {}) {
  if (!isId(req.params.id)) { fail(res, 404, "Season not found"); return null; }
  const q = CuttingSeason.findOne({ _id: oid(req.params.id), companyId: companyOf(req) });
  const s = forWrite ? await q : await q.lean();
  if (!s) { fail(res, 404, "Season not found"); return null; }
  return s;
}

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
    const f = { companyId: companyOf(req) };
    if (["draft", "active", "closed"].includes(req.query.status)) f.status = req.query.status;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await CuttingSeason.find(f).sort({ createdAt: -1 }).limit(limit).select("-pieces").lean();
    return res.json({ success: true, seasons: rows.map((s) => ({ ...seasonView(s), piecesCount: s.status === "closed" ? s.piecesCount : undefined, recentPieces: undefined })), openCount: await CuttingSeason.countDocuments({ companyId: companyOf(req), status: { $ne: "closed" } }) });
  } catch (err) { console.error("[cutting-seasons] list:", err); return fail(res, 500, err.message); }
});
/* live counts for open seasons are cheap to add here: the list above strips pieces */
router.get("/seasons/open", ...canRead, async (req, res) => {
  try {
    const rows = await CuttingSeason.find({ companyId: companyOf(req), status: { $ne: "closed" } }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, seasons: rows.map((s) => seasonView(s)) });
  } catch (err) { console.error("[cutting-seasons] open:", err); return fail(res, 500, err.message); }
});
router.post("/seasons", ...canWrite, async (req, res) => {
  try {
    const name = str(req.body?.name);
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
    if (!(await RawItem.exists({ _id: b.rawItem }))) return fail(res, 404, "The sticker's raw item no longer exists.");
    const other = await CuttingSeason.findOne({ companyId: companyOf(req), _id: { $ne: s._id }, status: { $ne: "closed" }, "rawItems.barcodeId": oid(id) }).select("name").lean();
    if (other) return fail(res, 409, `That sticker is already in the open season "${other.name}".`);
    if ((b.cuttingSessions || []).some((c) => !c.closedAt)) return fail(res, 409, `${b.rawItemName} has a cutting session still open from the old tracker. Close it there first.`);
    s.rawItems.push({ barcodeId: b._id, rawItemId: b.rawItem || null, rawItemName: b.rawItemName || "", rawItemSku: b.rawItemSku || "", variantId: b.variantId || null, variantText: (b.variantCombination || []).join(" · "), unit: b.unit || "", quantityAtScan: b.quantity || 0, scannedAt: new Date(), scannedBy: actorOf(req) });
    await s.save();
    return res.json({ success: true, duplicate: false, added: s.rawItems[s.rawItems.length - 1], season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] raw-item:", err); return fail(res, 500, err.message); }
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
      if (!b) { results.push({ input, status: "invalid", reason: "No raw-item sticker matches that code." }); continue; }
      if ((b.quantity || 0) <= 0) { results.push({ input, status: "invalid", reason: `${b.rawItemName || "This sticker"} has no quantity left.` }); continue; }
      if (!(await RawItem.exists({ _id: b.rawItem }))) { results.push({ input, status: "invalid", reason: "The sticker's raw item no longer exists." }); continue; }
      const other = await CuttingSeason.findOne({ companyId: companyOf(req), _id: { $ne: s._id }, status: { $ne: "closed" }, "rawItems.barcodeId": oid(id) }).select("name").lean();
      if (other) { results.push({ input, status: "invalid", reason: `Already in the open season "${other.name}".` }); continue; }
      if ((b.cuttingSessions || []).some((c) => !c.closedAt)) { results.push({ input, status: "invalid", reason: `${b.rawItemName} has a cutting session still open from the old tracker.` }); continue; }
      const row = { barcodeId: b._id, rawItemId: b.rawItem || null, rawItemName: b.rawItemName || "", rawItemSku: b.rawItemSku || "", variantId: b.variantId || null, variantText: (b.variantCombination || []).join(" · "), unit: b.unit || "", quantityAtScan: b.quantity || 0, scannedAt: plausibleAt(sc?.at, now), scannedBy: actorOf(req) };
      s.rawItems.push(row); seenIds.add(id);
      results.push({ input, status: "saved", barcodeId: id, added: { rawItemName: row.rawItemName, variantText: row.variantText, quantityAtScan: row.quantityAtScan, unit: row.unit } });
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
    if (s.status !== "active") return fail(res, 409, "Start the season before closing it.");
    const remaining = req.body?.remaining && typeof req.body.remaining === "object" ? req.body.remaining : {};
    for (const r of s.rawItems) {
      const raw = remaining[String(r.barcodeId)];
      const rem = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(rem) || rem < 0) return fail(res, 400, `Remaining quantity for ${r.rawItemName} must be a non-negative number.`);
      if (r.startQty != null && rem > r.startQty + 1e-6) return fail(res, 400, `${r.rawItemName}: remaining ${rem} ${r.unit} is more than the ${r.startQty} ${r.unit} it started with.`);
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
        session.endQty = rem; session.closedAt = new Date(); b.quantity = rem;
        await b.save();
        r.endQty = rem; r.usedQty = Math.round(((session.startQty || 0) - rem) * 10000) / 10000;
      } else if (session) { r.endQty = session.endQty; r.usedQty = Math.round(((session.startQty || 0) - (session.endQty || 0)) * 10000) / 10000; }
    }
    s.products = await tally(s);
    s.piecesCount = s.pieces.length;
    s.status = "closed"; s.closedAt = new Date(); s.closedBy = actorOf(req); s.note = str(req.body?.note || s.note).slice(0, 1000);
    await s.save();
    return res.json({ success: true, season: seasonView(s.toObject()) });
  } catch (err) { console.error("[cutting-seasons] close:", err); return fail(res, 500, err.message); }
});
router.post("/seasons/:id/discard", ...canWrite, async (req, res) => {
  try {
    const s = await loadSeason(req, res, { forWrite: true }); if (!s) return;
    if (s.status !== "draft") return fail(res, 409, "Only a season that has not started can be discarded. Close it instead.");
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
