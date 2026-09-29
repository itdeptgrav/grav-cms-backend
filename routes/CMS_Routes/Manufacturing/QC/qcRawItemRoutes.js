// routes/CMS_Routes/Manufacturing/QC/qcRawItemRoutes.js
//
// RAW ITEM CHECKING — QC's second book (28 Sep 2026).
//
// On a job-work order the customer sends the raw material, and a factory
// checks it before it is cut. This router is that check, mounted on
// /api/cms/manufacturing/qc/raw-items and kept entirely apart from the
// per-piece product inspection in qcRoutes.js: different model
// (QCRawItemInspection), different defect reasons (QCRawItemSetting kind
// "defect"), its own roster (kind "checker"). Nothing here touches, and
// nothing in the product check reads, the other's collection.
//
// The flow the floor asked for:
//   1. the checker picks the ORDER (search by MO number or customer);
//   2. scans a raw-item sticker (the Store's `itemid=<24 hex>` label — its
//      name, variant, quantity and unit come from the label);
//   3. passes it, or marks a defect from the reasons the owner defined,
//      with how much of the sticker's quantity is defective;
//   4. the order shows, raw item by raw item, how much is checked, passed,
//      defective and (against the order's requirement) still to check;
//   5. the checker sees their own day, hour by hour.
//
// Who may do what: the QC OWNER (or a platform administrator) sets up
// reasons and checkers and reads everything; a CHECKER (an active row on
// the roster, matched by email) may look up, save and see their own day.
// A person with a QC role but no roster row is told so in words.
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const { verifyCmsToken, readToken } = require("../../../../config/jwt");
const { getRole, listRoles } = require("../../../../services/departmentRoles");
const shift = require("../../../../services/manufacturing/shiftHours");
const QCRawItemInspection = require("../../../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");
const QCRawItemSetting = require("../../../../models/CMS_Models/Manufacturing/QC/QCRawItemSetting");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Employee = require("../../../../models/Employee");
const { CustomerMaterialLot } = require("../../../../models/CMS_Models/StorePurchase/CustomerMaterialLot");

const SLUG = "qc";
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();
const isJobWork = (mo) => mo?.fulfilmentModel === "JOB_WORK" || (mo?.items || []).some((i) => i.fulfilmentModel === "JOB_WORK");
const moNumberOf = (mo) => (mo?.requestId ? `MO-${mo.requestId}` : "");

/* ── who is asking ───────────────────────────────────────────────────────── */

function qcAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Please sign in." });
  let decoded = null;
  try { decoded = verifyCmsToken(token); } catch { decoded = null; }
  if (!decoded) return res.status(401).json({ success: false, message: "Your session has expired. Sign in again." });
  req.qcUser = { id: decoded.id, email: String(decoded.email || "").toLowerCase(), name: decoded.name || "", role: decoded.role, isAdmin: Boolean(decoded.isAdmin), employeeId: decoded.employeeId || "" };
  next();
}
router.use(qcAuth);

/** Resolve the caller once: their QC role, whether they own, whether they are a checker. */
async function whoAmI(req) {
  if (req.qcWho) return req.qcWho;
  const u = req.qcUser;
  const role = u.isAdmin ? "owner" : await getRole(SLUG, u.email);
  const owner = u.isAdmin || role === "owner";
  const now = new Date();
  const checkerRow = u.email ? await QCRawItemSetting.findOne({ kind: "checker", email: u.email, isActive: true, $or: [{ validFrom: null }, { validFrom: { $lte: now } }], $and: [{ $or: [{ validTo: null }, { validTo: { $gte: now } }] }] }).lean() : null;
  const emp = u.email ? await Employee.findOne({ email: u.email }).select("firstName middleName lastName biometricId").lean() : null;
  const name = emp ? [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim() || u.name : u.name;
  /* a raw item checker may be kept OFF the product piece station (29 Sep 2026);
     everyone else in QC, and the owner, keep it as before */
  const productCheck = owner || !checkerRow || checkerRow.productCheck !== false;
  req.qcWho = { email: u.email, name: name || u.email, biometricId: emp?.biometricId || checkerRow?.biometricId || "", role: role || null, owner, checker: Boolean(checkerRow) || owner, productCheck, checkerRow };
  return req.qcWho;
}
async function requireOwner(req, res, next) {
  try {
    const who = await whoAmI(req);
    if (who.owner) return next();
    return res.status(403).json({ success: false, code: who.role ? "INSUFFICIENT_DEPARTMENT_ROLE" : "NO_DEPARTMENT_ROLE", role: who.role, message: who.role ? `Only the QC owner can set this up. You are ${who.role}.` : "Only the QC owner can set this up. Ask an administrator to grant QC roles." });
  } catch (err) { res.status(500).json({ success: false, message: "Could not check your access." }); }
}
async function requireChecker(req, res, next) {
  try {
    const who = await whoAmI(req);
    if (who.checker) return next();
    return res.status(403).json({ success: false, code: "NOT_A_RAW_ITEM_CHECKER", message: "You are not assigned as a raw item checker. Ask the QC owner to add you on Raw item setup." });
  } catch (err) { res.status(500).json({ success: false, message: "Could not check your access." }); }
}
async function requireOwnerOrChecker(req, res, next) {
  try {
    const who = await whoAmI(req);
    if (who.owner || who.checker) return next();
    return res.status(403).json({ success: false, code: "NOT_A_RAW_ITEM_CHECKER", message: "Raw item checking is for the QC owner and the assigned checkers." });
  } catch (err) { res.status(500).json({ success: false, message: "Could not check your access." }); }
}

/* ── the setup ───────────────────────────────────────────────────────────── */

const defectView = (d) => ({ _id: d._id, code: d.code, name: d.name, category: d.category || "OTHER", description: d.description || "", sortOrder: d.sortOrder || 0, isActive: d.isActive !== false });
const checkerView = (c) => ({ _id: c._id, email: c.email, name: c.name || c.email, biometricId: c.biometricId || "", validFrom: c.validFrom, validTo: c.validTo, note: c.note || "", productCheck: c.productCheck !== false, isActive: c.isActive !== false, assignedByName: c.createdByName || "", assignedAt: c.createdAt });

/** Everyone in QC may read the setup — the scan page needs the reasons and to know whether it may scan. */
router.get("/config", async (req, res) => {
  try {
    const who = await whoAmI(req);
    const [defects, checkers] = await Promise.all([
      QCRawItemSetting.find({ kind: "defect", isActive: true }).sort({ sortOrder: 1, code: 1 }).lean(),
      who.owner ? QCRawItemSetting.find({ kind: "checker", isActive: true }).sort({ name: 1 }).lean() : [],
    ]);
    res.json({ success: true, me: { email: who.email, name: who.name, biometricId: who.biometricId, role: who.role, owner: who.owner, checker: who.checker, productCheck: who.productCheck }, defects: defects.map(defectView), checkers: checkers.map(checkerView), standardDefects: QCRawItemSetting.STANDARD_DEFECTS });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/defects", requireOwner, async (req, res) => {
  try {
    const code = str(req.body?.code).toUpperCase().replace(/\s+/g, "-").slice(0, 24);
    const name = str(req.body?.name).slice(0, 80);
    if (!code || !name) return res.status(400).json({ success: false, message: "Give the reason a short code and a name." });
    const dup = await QCRawItemSetting.findOne({ kind: "defect", code, isActive: true }).lean();
    if (dup) return res.status(409).json({ success: false, message: `The code ${code} is already used by "${dup.name}".` });
    const count = await QCRawItemSetting.countDocuments({ kind: "defect" });
    const who = await whoAmI(req);
    const doc = await QCRawItemSetting.create({ kind: "defect", code, name, category: str(req.body?.category).toUpperCase().slice(0, 30) || "OTHER", description: str(req.body?.description).slice(0, 300), sortOrder: count, createdByEmail: who.email, createdByName: who.name });
    res.status(201).json({ success: true, defect: defectView(doc) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.patch("/defects/:id", requireOwner, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: "Not a reason id." });
    const doc = await QCRawItemSetting.findOne({ _id: req.params.id, kind: "defect" });
    if (!doc) return res.status(404).json({ success: false, message: "That reason was not found." });
    const who = await whoAmI(req);
    if (req.body?.name !== undefined) doc.name = str(req.body.name).slice(0, 80) || doc.name;
    if (req.body?.category !== undefined) doc.category = str(req.body.category).toUpperCase().slice(0, 30) || "OTHER";
    if (req.body?.description !== undefined) doc.description = str(req.body.description).slice(0, 300);
    if (req.body?.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))) doc.sortOrder = Number(req.body.sortOrder);
    if (req.body?.isActive !== undefined) doc.isActive = Boolean(req.body.isActive);
    doc.updatedByEmail = who.email; doc.updatedByName = who.name;
    await doc.save();
    res.json({ success: true, defect: defectView(doc) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
/** Retire, never delete: past inspections name the reason by code. */
router.delete("/defects/:id", requireOwner, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: "Not a reason id." });
    const who = await whoAmI(req);
    const doc = await QCRawItemSetting.findOneAndUpdate({ _id: req.params.id, kind: "defect" }, { $set: { isActive: false, updatedByEmail: who.email, updatedByName: who.name } }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "That reason was not found." });
    res.json({ success: true, defect: defectView(doc) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post("/defects/load-standard", requireOwner, async (req, res) => {
  try {
    const who = await whoAmI(req);
    const have = new Set((await QCRawItemSetting.find({ kind: "defect", isActive: true }).select("code").lean()).map((d) => d.code));
    const count = await QCRawItemSetting.countDocuments({ kind: "defect" });
    const rows = QCRawItemSetting.STANDARD_DEFECTS.filter((d) => !have.has(d.code)).map((d, i) => ({ kind: "defect", ...d, sortOrder: count + i, createdByEmail: who.email, createdByName: who.name }));
    if (rows.length) await QCRawItemSetting.insertMany(rows);
    res.json({ success: true, added: rows.length, message: rows.length ? `${rows.length} standard reason${rows.length === 1 ? "" : "s"} added.` : "Every standard reason is already there." });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** The QC people the owner may make a checker: everyone with a QC role. */
router.get("/members", requireOwner, async (req, res) => {
  try {
    const roles = (await listRoles(SLUG)).filter((r) => r.isActive !== false);
    const emails = roles.map((r) => String(r.email).toLowerCase());
    const [emps, checkers] = await Promise.all([
      Employee.find({ email: { $in: emails } }).select("email firstName middleName lastName biometricId designation").lean(),
      QCRawItemSetting.find({ kind: "checker", isActive: true }).select("email").lean(),
    ]);
    const byEmail = new Map(emps.map((e) => [String(e.email).toLowerCase(), e]));
    const isChecker = new Set(checkers.map((c) => c.email));
    res.json({ success: true, members: roles.map((r) => { const e = byEmail.get(String(r.email).toLowerCase()); return { email: r.email, name: r.name || (e ? [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ") : r.email), role: r.role, biometricId: e?.biometricId || "", designation: e?.designation || "", isChecker: isChecker.has(String(r.email).toLowerCase()) }; }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post("/checkers", requireOwner, async (req, res) => {
  try {
    const email = str(req.body?.email).toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: "Choose a QC person." });
    const role = await getRole(SLUG, email);
    if (!role) return res.status(409).json({ success: false, message: `${email} has no QC role yet. Grant one under CEO › Access Control first.` });
    const dup = await QCRawItemSetting.findOne({ kind: "checker", email, isActive: true }).lean();
    if (dup) return res.status(409).json({ success: false, message: "That person is already a raw item checker." });
    const emp = await Employee.findOne({ email }).select("firstName middleName lastName biometricId").lean();
    const who = await whoAmI(req);
    const doc = await QCRawItemSetting.create({ kind: "checker", email, name: str(req.body?.name) || (emp ? [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ") : email), biometricId: emp?.biometricId || "", validFrom: req.body?.validFrom ? new Date(req.body.validFrom) : null, validTo: req.body?.validTo ? new Date(req.body.validTo) : null, note: str(req.body?.note).slice(0, 200), productCheck: req.body?.productCheck === undefined ? true : Boolean(req.body.productCheck), createdByEmail: who.email, createdByName: who.name });
    res.status(201).json({ success: true, checker: checkerView(doc) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
/** Change what a checker may do — today only whether they also inspect product pieces. */
router.patch("/checkers/:id", requireOwner, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: "Not a checker id." });
    const who = await whoAmI(req);
    const set = { updatedByEmail: who.email, updatedByName: who.name };
    if (req.body?.productCheck !== undefined) set.productCheck = Boolean(req.body.productCheck);
    const doc = await QCRawItemSetting.findOneAndUpdate({ _id: req.params.id, kind: "checker", isActive: true }, { $set: set }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "That checker was not found." });
    res.json({ success: true, checker: checkerView(doc), message: doc.productCheck ? `${doc.name || doc.email} may also inspect product pieces.` : `${doc.name || doc.email} checks raw items only.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.delete("/checkers/:id", requireOwner, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: "Not a checker id." });
    const who = await whoAmI(req);
    const doc = await QCRawItemSetting.findOneAndUpdate({ _id: req.params.id, kind: "checker" }, { $set: { isActive: false, validTo: new Date(), updatedByEmail: who.email, updatedByName: who.name } }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "That checker was not found." });
    res.json({ success: true, checker: checkerView(doc) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/* ── orders ──────────────────────────────────────────────────────────────── */

const LIVE = { status: { $nin: ["cancelled", "rejected", "draft", "pending"] } };
const MO_SELECT = "requestId customerInfo.name customerInfo.deliveryDeadline requestType status createdAt fulfilmentModel items.fulfilmentModel items.stockItemName";

/** Per order, what has been checked (non-superseded records only). */
async function rollups(moIds = null) {
  const match = { superseded: { $ne: true } };
  if (moIds) match.manufacturingOrderId = { $in: moIds.map(oid) };
  const rows = await QCRawItemInspection.aggregate([
    { $match: match },
    { $group: { _id: "$manufacturingOrderId", stickers: { $sum: 1 }, checkedQty: { $sum: "$quantity" }, passedQty: { $sum: "$passedQuantity" }, defectiveQty: { $sum: "$defectiveQuantity" }, defectiveStickers: { $sum: { $cond: [{ $eq: ["$status", "defective"] }, 1, 0] } }, rawItems: { $addToSet: { i: "$rawItemId", v: "$variantId" } }, lastAt: { $max: "$inspectedAt" }, checkers: { $addToSet: "$inspectedByEmail" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { stickers: r.stickers, checkedQty: r4(r.checkedQty), passedQty: r4(r.passedQty), defectiveQty: r4(r.defectiveQty), defectiveStickers: r.defectiveStickers, rawItems: r.rawItems.length, lastAt: r.lastAt, checkers: r.checkers.length }]));
}
const ZERO = { stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defectiveStickers: 0, rawItems: 0, lastAt: null, checkers: 0 };

const orderRow = (mo, r) => ({
  manufacturingOrderId: String(mo._id), moNumber: moNumberOf(mo), requestId: mo.requestId || "", customerName: mo.customerInfo?.name || "—", requestType: mo.requestType || "", status: mo.status || "", createdAt: mo.createdAt || null, deliveryDate: mo.customerInfo?.deliveryDeadline || null,
  isJobWork: isJobWork(mo), jobWorkLines: (mo.items || []).filter((i) => i.fulfilmentModel === "JOB_WORK").length, products: (mo.items || []).length,
  ...(r || ZERO),
});

/** The orders a checker may pick, and the owner's list: every live order, job work first, with what is checked. */
router.get("/orders", requireOwnerOrChecker, async (req, res) => {
  try {
    const q = str(req.query.q).toLowerCase();
    const scope = str(req.query.scope) || "all"; // all | jobwork | checked
    const [mos, rl] = await Promise.all([CustomerRequest.find(LIVE).select(MO_SELECT).sort({ createdAt: -1 }).lean(), rollups(null)]);
    let out = mos.map((mo) => orderRow(mo, rl.get(String(mo._id))));
    if (scope === "jobwork") out = out.filter((o) => o.isJobWork);
    if (scope === "checked") out = out.filter((o) => o.stickers > 0);
    if (q) out = out.filter((o) => [o.moNumber, o.requestId, o.customerName].some((v) => String(v).toLowerCase().includes(q)));
    out.sort((a, b) => (b.isJobWork - a.isJobWork) || (b.stickers > 0) - (a.stickers > 0) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, orders: out, counts: { all: mos.length, jobwork: out.filter((o) => o.isJobWork).length, checked: [...rl.keys()].length } });
  } catch (err) { console.error("[qc raw-items orders]", err); res.status(500).json({ success: false, message: err.message }); }
});

/** What the order needs (its work orders' bills of material) and what has been checked, raw item by raw item. */
router.get("/orders/:moId", requireOwnerOrChecker, async (req, res) => {
  try {
    if (!isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
    const mo = await CustomerRequest.findById(req.params.moId).select(MO_SELECT).lean();
    if (!mo) return res.status(404).json({ success: false, message: "That order was not found." });
    const [wos, lots, records, rl] = await Promise.all([
      WorkOrder.find({ customerRequestId: mo._id }).select("rawMaterials workOrderNumber quantity stockItemName status").lean(),
      /* on a job-work order the customer's material arrives as lots — what was
         RECEIVED for this order is the better "how much to check" than the bill */
      CustomerMaterialLot.find({ $or: [{ orderRef: { $in: [mo.requestId, moNumberOf(mo)].filter(Boolean) } }, { "movements.manufacturingOrderId": mo._id }] }).select("rawItemId variantId itemName sku baseUnit baseQuantity receiptQuantity receiptUnit").lean().catch(() => []),
      QCRawItemInspection.find({ manufacturingOrderId: mo._id }).sort({ inspectedAt: -1 }).lean(),
      rollups([String(mo._id)]),
    ]);
    const receivedByKey = new Map();
    for (const l of lots || []) { const key = `${l.rawItemId || ""}|${l.variantId || ""}`; const cur = receivedByKey.get(key) || { received: 0, unit: l.baseUnit || l.receiptUnit || "", itemName: l.itemName || "", sku: l.sku || "" }; cur.received = r4(cur.received + (l.baseQuantity ?? l.receiptQuantity ?? 0)); receivedByKey.set(key, cur); }
    /* required, from the work orders' bills of material — the same source the Store's requirement reads */
    const need = new Map();
    for (const w of wos) for (const rm of w.rawMaterials || []) {
      const key = `${rm.rawItemId || ""}|${rm.rawItemVariantId || ""}`;
      const cur = need.get(key) || { rawItemId: rm.rawItemId ? String(rm.rawItemId) : "", variantId: rm.rawItemVariantId ? String(rm.rawItemVariantId) : null, rawItemName: rm.name || "", rawItemSku: rm.sku || "", variantLabel: (rm.rawItemVariantCombination || []).join(" · "), unit: rm.unit || "", required: 0 };
      cur.required = r4(cur.required + (rm.quantityRequired || 0));
      need.set(key, cur);
    }
    /* checked, from the records that stand */
    const live = records.filter((r) => !r.superseded);
    const items = new Map();
    for (const [key, n] of need) items.set(key, { ...n, received: null, stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defects: new Map(), lastAt: null });
    for (const [key, rcv] of receivedByKey) {
      const cur = items.get(key) || { rawItemId: key.split("|")[0], variantId: key.split("|")[1] || null, rawItemName: rcv.itemName, rawItemSku: rcv.sku, variantLabel: "", unit: rcv.unit, required: null, stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defects: new Map(), lastAt: null };
      cur.received = rcv.received; items.set(key, cur);
    }
    for (const r of live) {
      const key = `${r.rawItemId || ""}|${r.variantId || ""}`;
      const cur = items.get(key) || { rawItemId: r.rawItemId ? String(r.rawItemId) : "", variantId: r.variantId ? String(r.variantId) : null, rawItemName: r.rawItemName, rawItemSku: r.rawItemSku, variantLabel: r.variantLabel, unit: r.unit, required: null, received: null, stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defects: new Map(), lastAt: null };
      cur.stickers += 1; cur.checkedQty = r4(cur.checkedQty + r.quantity); cur.passedQty = r4(cur.passedQty + r.passedQuantity); cur.defectiveQty = r4(cur.defectiveQty + r.defectiveQuantity);
      if (!cur.lastAt || r.inspectedAt > cur.lastAt) cur.lastAt = r.inspectedAt;
      for (const d of r.defects || []) { const x = cur.defects.get(d.code) || { code: d.code, name: d.name, stickers: 0, quantity: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); cur.defects.set(d.code, x); }
      items.set(key, cur);
    }
    /* what there is to check: the quantity RECEIVED for the order when the
       Store recorded lots, else what the bill of material requires */
    const rawItems = [...items.values()].map((x) => { const expected = x.received != null && x.received > 0 ? x.received : x.required; return { ...x, expected, expectedFrom: x.received != null && x.received > 0 ? "received" : x.required != null ? "required" : null, defects: [...x.defects.values()].sort((a, b) => b.quantity - a.quantity), remaining: expected != null ? r4(Math.max(0, expected - x.checkedQty)) : null, pct: expected ? Math.min(100, Math.round((x.checkedQty / expected) * 100)) : null, state: expected == null ? (x.stickers ? "checked" : "none") : x.checkedQty >= expected ? "done" : x.checkedQty > 0 ? "partly" : "waiting" }; })
      .sort((a, b) => (b.stickers - a.stickers) || a.rawItemName.localeCompare(b.rawItemName));
    const byDefect = new Map();
    for (const r of live) for (const d of r.defects || []) { const x = byDefect.get(d.code) || { code: d.code, name: d.name, stickers: 0, quantity: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); byDefect.set(d.code, x); }
    const byChecker = new Map();
    for (const r of live) { const x = byChecker.get(r.inspectedByEmail) || { email: r.inspectedByEmail, name: r.inspectedByName, stickers: 0, quantity: 0, defective: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.quantity); x.defective += r.status === "defective" ? 1 : 0; byChecker.set(r.inspectedByEmail, x); }
    const totals = rl.get(String(mo._id)) || ZERO;
    const required = rawItems.reduce((n, x) => n + (x.required || 0), 0);
    const received = rawItems.reduce((n, x) => n + (x.received || 0), 0);
    const expected = rawItems.reduce((n, x) => n + (x.expected || 0), 0);
    res.json({ success: true, order: orderRow(mo, totals), summary: { ...totals, required: r4(required), received: r4(received), expected: r4(expected), remaining: r4(rawItems.reduce((n, x) => n + (x.remaining || 0), 0)), rawItemsRequired: rawItems.filter((x) => x.expected != null).length, rawItemsDone: rawItems.filter((x) => x.state === "done").length, workOrders: wos.length, lots: (lots || []).length }, rawItems, byDefect: [...byDefect.values()].sort((a, b) => b.quantity - a.quantity), byChecker: [...byChecker.values()].sort((a, b) => b.stickers - a.stickers), recent: records.slice(0, 200).map(recordView) });
  } catch (err) { console.error("[qc raw-items order]", err); res.status(500).json({ success: false, message: err.message }); }
});

function recordView(r) {
  return { _id: r._id, date: r.date, inspectedAt: r.inspectedAt, moNumber: r.moNumber, customerName: r.customerName, manufacturingOrderId: String(r.manufacturingOrderId), barcodeId: String(r.barcodeId), rawItemName: r.rawItemName, rawItemSku: r.rawItemSku, variantLabel: r.variantLabel, quantity: r.quantity, unit: r.unit, purchaseOrderNumber: r.purchaseOrderNumber, vendorName: r.vendorName, status: r.status, passedQuantity: r.passedQuantity, defectiveQuantity: r.defectiveQuantity, defects: r.defects || [], note: r.note || "", inspectedByName: r.inspectedByName, inspectedByEmail: r.inspectedByEmail, superseded: Boolean(r.superseded), hourKey: r.hourKey };
}

/* ── the scan ────────────────────────────────────────────────────────────── */

/** The sticker's id from whatever the scanner or camera read. */
function stickerIdOf(raw) {
  const s = str(raw);
  if (!s) return null;
  const m = /(?:itemid=|RawItem=)([0-9a-f]{24})/i.exec(s) || /^([0-9a-f]{24})$/i.exec(s);
  return m ? m[1] : null;
}
const stickerView = (b) => ({
  barcodeId: String(b._id), rawItemId: b.rawItem ? String(b.rawItem) : null, rawItemName: b.rawItemName || "—", rawItemSku: b.rawItemSku || "", variantId: b.variantId ? String(b.variantId) : null, variantLabel: (b.variantCombination || []).join(" · ") || "", variantSku: b.variantSku || "",
  quantity: r4(b.quantity), unit: b.unit || "", purchaseOrderNumber: b.purchaseOrderNumber || "", vendorName: b.vendorName || "", printedAt: b.createdAt,
  customerOrderRef: b.customerMaterial?.orderRef || "", customerLabel: b.customerMaterial?.customerLabel || "",
});

/** Look a sticker up against an order: what it is, and whether it was already checked. */
router.post("/lookup", requireOwnerOrChecker, async (req, res) => {
  try {
    const id = stickerIdOf(req.body?.code);
    if (!id) return res.status(400).json({ success: false, code: "NOT_A_STICKER", message: "That is not a raw item label. Scan the Store's label on the raw item (it reads itemid=…)." });
    if (!isId(req.body?.moId)) return res.status(400).json({ success: false, message: "Choose the order first." });
    const [b, mo] = await Promise.all([Barcode.findById(id).lean(), CustomerRequest.findById(req.body.moId).select(MO_SELECT).lean()]);
    if (!b) return res.status(404).json({ success: false, code: "UNKNOWN_STICKER", message: "No raw item with that label is on record." });
    if (!mo) return res.status(404).json({ success: false, message: "That order was not found." });
    const [onThis, elsewhere] = await Promise.all([
      QCRawItemInspection.findOne({ barcodeId: b._id, manufacturingOrderId: mo._id, superseded: { $ne: true } }).lean(),
      QCRawItemInspection.find({ barcodeId: b._id, manufacturingOrderId: { $ne: mo._id }, superseded: { $ne: true } }).select("moNumber status inspectedAt inspectedByName").lean(),
    ]);
    const warnings = [];
    const ref = b.customerMaterial?.orderRef || "";
    if (ref && ref !== mo.requestId && ref !== moNumberOf(mo)) warnings.push(`This raw item was received for ${ref}, not ${moNumberOf(mo)}.`);
    if (!(b.quantity > 0)) warnings.push("This raw item shows no quantity left (it was used up).");
    if (elsewhere.length) warnings.push(`Already checked on ${elsewhere.map((e) => e.moNumber).join(", ")}.`);
    res.json({ success: true, sticker: stickerView(b), order: { manufacturingOrderId: String(mo._id), moNumber: moNumberOf(mo), customerName: mo.customerInfo?.name || "", isJobWork: isJobWork(mo) }, prior: onThis ? recordView(onThis) : null, warnings });
  } catch (err) { console.error("[qc raw-items lookup]", err); res.status(500).json({ success: false, message: err.message }); }
});

/** Record the verdict. `recheck: true` replaces an earlier verdict for the same sticker on the same order. */
router.post("/save", requireChecker, async (req, res) => {
  try {
    const { moId, barcodeId, status, defects, defectiveQuantity, note, recheck } = req.body || {};
    if (!isId(moId)) return res.status(400).json({ success: false, message: "Choose the order first." });
    if (!isId(barcodeId)) return res.status(400).json({ success: false, message: "Scan the raw item first." });
    if (!["passed", "defective"].includes(status)) return res.status(400).json({ success: false, message: "Pass the raw item, or mark a defect." });
    const [b, mo, who] = await Promise.all([Barcode.findById(barcodeId).lean(), CustomerRequest.findById(moId).select(MO_SELECT).lean(), whoAmI(req)]);
    if (!b) return res.status(404).json({ success: false, message: "No raw item with that label is on record." });
    if (!mo) return res.status(404).json({ success: false, message: "That order was not found." });
    const qty = r4(b.quantity);
    if (!(qty > 0)) return res.status(409).json({ success: false, message: "This raw item shows no quantity left — there is nothing to check." });

    let picked = [];
    let defQty = 0;
    if (status === "defective") {
      const codes = [...new Set((Array.isArray(defects) ? defects : []).map((d) => str(typeof d === "string" ? d : d?.code).toUpperCase()).filter(Boolean))];
      if (!codes.length) return res.status(400).json({ success: false, message: "Pick at least one reason for the defect." });
      const known = await QCRawItemSetting.find({ kind: "defect", code: { $in: codes }, isActive: true }).lean();
      const byCode = new Map(known.map((d) => [d.code, d]));
      const unknown = codes.filter((c) => !byCode.has(c));
      if (unknown.length) return res.status(400).json({ success: false, message: `Unknown reason${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. The owner defines them on Raw item setup.` });
      picked = codes.map((c) => ({ code: c, name: byCode.get(c).name, category: byCode.get(c).category || "" }));
      defQty = defectiveQuantity === undefined || defectiveQuantity === null || defectiveQuantity === "" ? qty : r4(defectiveQuantity);
      if (!(defQty > 0) || defQty > qty) return res.status(400).json({ success: false, message: `The defective quantity must be between 0 and ${qty} ${b.unit || ""}.`.trim() });
      if (codes.includes("OTHER") && !str(note)) return res.status(400).json({ success: false, message: "Write what the problem is when the reason is Other." });
    }
    const prior = await QCRawItemInspection.findOne({ barcodeId: b._id, manufacturingOrderId: mo._id, superseded: { $ne: true } });
    if (prior && !recheck) return res.status(409).json({ success: false, code: "ALREADY_CHECKED", message: `This raw item was already ${prior.status} on ${moNumberOf(mo)} by ${prior.inspectedByName || "QC"}. Check it again to replace that verdict.`, prior: recordView(prior) });

    const now = new Date();
    const doc = await QCRawItemInspection.create({
      date: shift.istDayKeyOf(now), hourKey: shift.shiftBuckets()[shift.bucketIndexOf(now)]?.key || "",
      manufacturingOrderId: mo._id, moNumber: moNumberOf(mo), customerName: mo.customerInfo?.name || "", isJobWork: isJobWork(mo),
      barcodeId: b._id, rawItemId: b.rawItem || null, rawItemName: b.rawItemName || "", rawItemSku: b.rawItemSku || "", variantId: b.variantId || null, variantLabel: (b.variantCombination || []).join(" · "), quantity: qty, unit: b.unit || "", purchaseOrderNumber: b.purchaseOrderNumber || "", vendorName: b.vendorName || "",
      status, passedQuantity: status === "passed" ? qty : r4(qty - defQty), defectiveQuantity: status === "passed" ? 0 : defQty, defects: picked, note: str(note).slice(0, 500),
      inspectedByEmail: who.email, inspectedByName: who.name, inspectedByBiometricId: who.biometricId, inspectedAt: now,
    });
    if (prior) { prior.superseded = true; prior.supersededById = doc._id; prior.supersededAt = now; await prior.save(); }
    const rl = (await rollups([String(mo._id)])).get(String(mo._id)) || ZERO;
    res.status(201).json({ success: true, record: recordView(doc), replaced: prior ? String(prior._id) : null, orderTotals: rl, message: status === "passed" ? `Passed: ${qty} ${b.unit || ""} of ${b.rawItemName}.` : `Defect marked on ${b.rawItemName}: ${defQty} ${b.unit || ""} defective, ${r4(qty - defQty)} passed.` });
  } catch (err) { console.error("[qc raw-items save]", err); res.status(500).json({ success: false, message: err.message }); }
});

/* ── the checker's day, and the owner's report ───────────────────────────── */

function dayShape(records, buckets) {
  const hours = buckets.map((b) => ({ ...b, stickers: 0, quantity: 0, passed: 0, defective: 0 }));
  const idx = new Map(buckets.map((b, i) => [b.key, i]));
  const orders = new Map(); const rawItems = new Map(); const defects = new Map();
  for (const r of records) {
    const h = hours[idx.get(r.hourKey) ?? shift.bucketIndexOf(r.inspectedAt)];
    if (h) { h.stickers += 1; h.quantity = r4(h.quantity + r.quantity); h.passed = r4(h.passed + r.passedQuantity); h.defective = r4(h.defective + r.defectiveQuantity); }
    const o = orders.get(String(r.manufacturingOrderId)) || { manufacturingOrderId: String(r.manufacturingOrderId), moNumber: r.moNumber, customerName: r.customerName, stickers: 0, quantity: 0, passed: 0, defective: 0, defectiveQty: 0, items: new Map(), lastAt: null };
    o.stickers += 1; o.quantity = r4(o.quantity + r.quantity); o.passed = r4(o.passed + r.passedQuantity); o.defective += r.status === "defective" ? 1 : 0; o.defectiveQty = r4(o.defectiveQty + r.defectiveQuantity);
    if (!o.lastAt || r.inspectedAt > o.lastAt) o.lastAt = r.inspectedAt;
    /* the same product-variant scanned under several labels is ONE row (29 Sep
       2026: "12 + 10 = 22", not two lines) */
    const ik = `${r.rawItemName}|${r.variantLabel}`;
    const it = o.items.get(ik) || { rawItemName: r.rawItemName, variantLabel: r.variantLabel, rawItemSku: r.rawItemSku, unit: r.unit, scans: 0, quantity: 0, passed: 0, defective: 0, reasons: new Map(), notes: [], checkers: new Set(), lastAt: null };
    it.scans += 1; it.quantity = r4(it.quantity + r.quantity); it.passed = r4(it.passed + r.passedQuantity); it.defective = r4(it.defective + r.defectiveQuantity);
    for (const d of r.defects || []) { const x = it.reasons.get(d.code) || { code: d.code, name: d.name, scans: 0, quantity: 0 }; x.scans += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); it.reasons.set(d.code, x); }
    if (r.note) it.notes.push(r.note); it.checkers.add(r.inspectedByName || r.inspectedByEmail);
    if (!it.lastAt || r.inspectedAt > it.lastAt) it.lastAt = r.inspectedAt;
    o.items.set(ik, it); orders.set(o.manufacturingOrderId, o);
    const k = `${r.rawItemName}|${r.variantLabel}`;
    const ri = rawItems.get(k) || { rawItemName: r.rawItemName, variantLabel: r.variantLabel, unit: r.unit, stickers: 0, quantity: 0, passed: 0, defective: 0 };
    ri.stickers += 1; ri.quantity = r4(ri.quantity + r.quantity); ri.passed = r4(ri.passed + r.passedQuantity); ri.defective = r4(ri.defective + r.defectiveQuantity); rawItems.set(k, ri);
    for (const d of r.defects || []) { const x = defects.get(d.code) || { code: d.code, name: d.name, stickers: 0, quantity: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); defects.set(d.code, x); }
  }
  const stickers = records.length;
  const quantity = r4(records.reduce((n, r) => n + r.quantity, 0));
  const passedQty = r4(records.reduce((n, r) => n + r.passedQuantity, 0));
  const defectiveQty = r4(records.reduce((n, r) => n + r.defectiveQuantity, 0));
  const peak = hours.reduce((m, h) => (h.stickers > (m?.stickers || 0) ? h : m), null);
  return {
    totals: { stickers, quantity, passedQty, defectiveQty, passedStickers: records.filter((r) => r.status === "passed").length, defectiveStickers: records.filter((r) => r.status === "defective").length, orders: orders.size, rawItems: rawItems.size, passRate: quantity ? Math.round((passedQty / quantity) * 100) : null, peakHour: peak && peak.stickers ? peak.label : null, firstAt: records.length ? records[records.length - 1].inspectedAt : null, lastAt: records.length ? records[0].inspectedAt : null },
    hours, byOrder: [...orders.values()].map((o) => ({ ...o, items: [...o.items.values()].map((it) => ({ ...it, reasons: [...it.reasons.values()].sort((a, b) => b.quantity - a.quantity), checkers: [...it.checkers], notes: it.notes.slice(0, 20) })).sort((a, b) => b.quantity - a.quantity) })).sort((a, b) => b.stickers - a.stickers), byRawItem: [...rawItems.values()].sort((a, b) => b.stickers - a.stickers), byDefect: [...defects.values()].sort((a, b) => b.quantity - a.quantity),
  };
}

/** One person's day (their own; the owner may name anyone, or "all"). */
router.get("/my-day", requireOwnerOrChecker, async (req, res) => {
  try {
    const who = await whoAmI(req);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(str(req.query.date)) ? str(req.query.date) : shift.istDayKeyOf(new Date());
    let email = who.email;
    if (who.owner && str(req.query.email)) email = str(req.query.email).toLowerCase();
    const match = { date, superseded: { $ne: true } };
    if (email !== "all") match.inspectedByEmail = email;
    const records = await QCRawItemInspection.find(match).sort({ inspectedAt: -1 }).lean();
    res.json({ success: true, date, isToday: date === shift.istDayKeyOf(new Date()), email, name: email === "all" ? "Everyone" : (records[0]?.inspectedByName || (email === who.email ? who.name : email)), shift: shift.SHIFT, ...dayShape(records, shift.shiftBuckets()), recent: records.slice(0, 50).map(recordView) });
  } catch (err) { console.error("[qc raw-items my-day]", err); res.status(500).json({ success: false, message: err.message }); }
});

/** The owner's report over a range: by day, checker, order, raw item and reason. */
router.get("/report", requireOwner, async (req, res) => {
  try {
    const today = shift.istDayKeyOf(new Date());
    const to = /^\d{4}-\d{2}-\d{2}$/.test(str(req.query.to)) ? str(req.query.to) : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(str(req.query.from)) ? str(req.query.from) : new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
    const records = await QCRawItemInspection.find({ date: { $gte: from, $lte: to }, superseded: { $ne: true } }).sort({ inspectedAt: -1 }).lean();
    const byDay = new Map(); const byChecker = new Map();
    for (const r of records) {
      const d = byDay.get(r.date) || { date: r.date, stickers: 0, quantity: 0, passed: 0, defective: 0, checkers: new Set() };
      d.stickers += 1; d.quantity = r4(d.quantity + r.quantity); d.passed = r4(d.passed + r.passedQuantity); d.defective = r4(d.defective + r.defectiveQuantity); d.checkers.add(r.inspectedByEmail); byDay.set(r.date, d);
      const c = byChecker.get(r.inspectedByEmail) || { email: r.inspectedByEmail, name: r.inspectedByName, stickers: 0, quantity: 0, passed: 0, defective: 0, days: new Set() };
      c.stickers += 1; c.quantity = r4(c.quantity + r.quantity); c.passed = r4(c.passed + r.passedQuantity); c.defective = r4(c.defective + r.defectiveQuantity); c.days.add(r.date); byChecker.set(r.inspectedByEmail, c);
    }
    const shape = dayShape(records, shift.shiftBuckets());
    res.json({ success: true, from, to, ...shape, byDay: [...byDay.values()].map((d) => ({ ...d, checkers: d.checkers.size })).sort((a, b) => a.date.localeCompare(b.date)), byChecker: [...byChecker.values()].map((c) => ({ ...c, days: c.days.size })).sort((a, b) => b.stickers - a.stickers), recent: records.slice(0, 100).map(recordView) });
  } catch (err) { console.error("[qc raw-items report]", err); res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
