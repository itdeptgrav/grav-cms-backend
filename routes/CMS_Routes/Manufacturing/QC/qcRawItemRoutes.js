// routes/CMS_Routes/Manufacturing/QC/qcRawItemRoutes.js
//
// RAW ITEM CHECKING — QC's second book (28 Sep 2026).
//
// Raw material is checked before it is cut, because a defect found after cutting
// is a defect you have paid to create. This router is that check, mounted on
// /api/cms/manufacturing/qc/raw-items and kept entirely apart from the
// per-piece product inspection in qcRoutes.js: different model
// (QCRawItemInspection), different defect reasons (QCRawItemSetting kind
// "defect"), its own roster (kind "checker"). Nothing here touches, and
// nothing in the product check reads, the other's collection.
//
// ── EVERY ELIGIBLE ORDER, NOT ONLY JOB WORK (29 Sep 2026) ──────────────────
// This shipped for job work: the customer sends the cloth, so `/orders` filtered
// on `fulfilmentModel === "JOB_WORK"` and the per-order figures counted only
// CUSTOMER_MATERIAL goods receipts.
//
// That conflated WHO OWNS THE MATERIAL with WHETHER IT NEEDS INSPECTING. A roll
// the factory bought can arrive short, shaded wrong or holed exactly as a
// customer's can. Eligibility is now the material REQUIREMENT — see
// services/manufacturing/qcRawItemOrders.js, which reads
// `WorkOrder.rawMaterials[]` — and ownership is carried as descriptive context
// (`materialSource`) that the Orders screen may filter by and that decides
// nothing.
//
// The flow, scan-first since 29 Sep 2026:
//   1. the checker scans a raw-item label on the unified Inspect screen (the
//      Store's label, in any of its four forms — see
//      services/manufacturing/qcBarcodeIdentity.js);
//   2. the ORDER is resolved from the label, the standing verdicts and who needs
//      the material, and is asked for only when genuinely ambiguous;
//   3. they pass it, or mark a defect from the reasons the owner defined,
//      with how much of the label's quantity is defective;
//   4. the order shows, raw item by raw item, how much is checked, passed,
//      defective and (against what arrived) still to check;
//   5. the checker sees their own day, hour by hour.
//
// Who may do what: the QC OWNER (or a platform administrator) sets up
// reasons and checkers and reads everything; a CHECKER (an active row on
// the roster, matched by email) may look up, save and see their own day.
// A person with a QC role but no roster row is told so in words.
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const { boundedRecordedAt } = require("../../../../services/manufacturing/recordedAt");
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
const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
const { CustomerMaterialExpectation } = require("../../../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const { resolveQcActor } = require("../../../../services/manufacturing/qcActor");
const { classifyQcBarcode } = require("../../../../services/manufacturing/qcBarcodeIdentity");
const qcOrders = require("../../../../services/manufacturing/qcRawItemOrders");
const qcGrns = require("../../../../services/manufacturing/qcRawItemGrns");

const SLUG = "qc";
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();
/* DESCRIPTIVE, NEVER A GATE (29 Sep 2026). Sales marking an order as job work is
   real information — it means the customer is sending the material — and it is
   reported on the order row and stored on each record. What it no longer does is
   decide whether the order may be inspected. See the header. */
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

/**
 * Resolve the caller once: their QC role, whether they own, whether they check.
 *
 * MOVED TO services/manufacturing/qcActor.js (29 Sep 2026) and delegated to from
 * here. The unified Inspect screen's `/identify-barcode` needs the same three
 * capabilities to say whether somebody may open the branch a barcode resolved
 * to, and it cannot read a capability model that lives inside this router. The
 * rules did not change; `req.qcWho` is still the per-request cache.
 */
const whoAmI = (req) => resolveQcActor(req);

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
    return res.status(403).json({ success: false, code: "NOT_A_RAW_ITEM_CHECKER", message: "You are not assigned as a raw-material checker. Ask the QC owner to add you under Setup \u203a Raw-material QC." });
  } catch (err) { res.status(500).json({ success: false, message: "Could not check your access." }); }
}
async function requireOwnerOrChecker(req, res, next) {
  try {
    const who = await whoAmI(req);
    if (who.owner || who.checker) return next();
    return res.status(403).json({ success: false, code: "NOT_A_RAW_ITEM_CHECKER", message: "Raw material checking is for the QC owner and the assigned checkers." });
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

/**
 * Per order, what has been checked (non-superseded records only).
 *
 * ── `byUnit` IS WHY THIS GROUPS TWICE (29 Sep 2026) ──────────────────────
 * `checkedQty`, `passedQty` and `defectiveQty` are quantities of MATERIAL, and
 * an order's materials are not all measured the same way — 40 metres of fabric
 * and 2 kilograms of thread and 500 pieces of button are three different
 * quantities. Summing them gives a number with no unit and no meaning, which is
 * exactly what a single `$group` on the order did and still does: those three
 * fields are BYTE-IDENTICAL to what they were, because a reader that already
 * shows them (the raw-material order page's own totals) must not change.
 *
 * What is new is `byUnit`: the same figures cut by the record's `unit`, so a
 * caller can say "420 m passed · 15 m defective" when the order is measured one
 * way and refuse to total anything when it is measured several. The unified QC
 * Orders list is built on it. An empty unit (a record saved before the label
 * carried one) is its own bucket, spelled "", never folded into another.
 *
 * The first stage groups by (order, unit); the second rolls those up to the
 * order. `rawItems` and `checkers` become arrays OF ARRAYS on the way through,
 * so both are flattened to a set here rather than counted twice.
 */
async function rollups(moIds = null) {
  const match = { superseded: { $ne: true } };
  if (moIds) match.manufacturingOrderId = { $in: moIds.map(oid) };
  const rows = await QCRawItemInspection.aggregate([
    { $match: match },
    { $group: { _id: { mo: "$manufacturingOrderId", unit: { $ifNull: ["$unit", ""] } }, stickers: { $sum: 1 }, checkedQty: { $sum: "$quantity" }, passedQty: { $sum: "$passedQuantity" }, defectiveQty: { $sum: "$defectiveQuantity" }, defectiveStickers: { $sum: { $cond: [{ $eq: ["$status", "defective"] }, 1, 0] } }, rawItems: { $addToSet: { i: "$rawItemId", v: "$variantId" } }, lastAt: { $max: "$inspectedAt" }, checkers: { $addToSet: "$inspectedByEmail" } } },
    { $group: { _id: "$_id.mo", stickers: { $sum: "$stickers" }, checkedQty: { $sum: "$checkedQty" }, passedQty: { $sum: "$passedQty" }, defectiveQty: { $sum: "$defectiveQty" }, defectiveStickers: { $sum: "$defectiveStickers" }, rawItemSets: { $push: "$rawItems" }, checkerSets: { $push: "$checkers" }, lastAt: { $max: "$lastAt" }, byUnit: { $push: { unit: "$_id.unit", stickers: "$stickers", checkedQty: "$checkedQty", passedQty: "$passedQty", defectiveQty: "$defectiveQty", defectiveStickers: "$defectiveStickers" } } } },
  ]);
  const distinct = (sets, key) => { const s = new Set(); for (const arr of sets || []) for (const v of arr || []) s.add(key(v)); return s.size; };
  return new Map(rows.map((r) => [String(r._id), {
    stickers: r.stickers, checkedQty: r4(r.checkedQty), passedQty: r4(r.passedQty), defectiveQty: r4(r.defectiveQty), defectiveStickers: r.defectiveStickers,
    rawItems: distinct(r.rawItemSets, (v) => `${v.i || ""}|${v.v || ""}`),
    lastAt: r.lastAt,
    checkers: distinct(r.checkerSets, (v) => String(v || "")),
    /* Biggest first, so a caller showing one line shows the one that matters. */
    byUnit: (r.byUnit || []).map((u) => ({ unit: u.unit || "", stickers: u.stickers, checkedQty: r4(u.checkedQty), passedQty: r4(u.passedQty), defectiveQty: r4(u.defectiveQty), defectiveStickers: u.defectiveStickers })).sort((a, b) => b.checkedQty - a.checkedQty || String(a.unit).localeCompare(String(b.unit))),
  }]));
}
const ZERO = { stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defectiveStickers: 0, rawItems: 0, lastAt: null, checkers: 0, byUnit: [] };

const orderRow = (mo, r) => ({
  manufacturingOrderId: String(mo._id), moNumber: moNumberOf(mo), requestId: mo.requestId || "", customerName: mo.customerInfo?.name || "—", requestType: mo.requestType || "", status: mo.status || "", createdAt: mo.createdAt || null, deliveryDate: mo.customerInfo?.deliveryDeadline || null,
  isJobWork: isJobWork(mo), jobWorkLines: (mo.items || []).filter((i) => i.fulfilmentModel === "JOB_WORK").length, products: (mo.items || []).length,
  ...(r || ZERO),
});

/**
 * EVERY ELIGIBLE ORDER (29 Sep 2026). Eligibility is the material REQUIREMENT,
 * not who owns the material: an order qualifies when a live work order of it
 * allocates raw material, or something has already been checked on it, or
 * customer material was received against it. See
 * services/manufacturing/qcRawItemOrders.js for why the job-work filter this
 * replaces was the wrong question.
 *
 * `scope`  all (the default) | checked | requires
 * `source` all (the default) | FACTORY_PROCURED | CUSTOMER_SUPPLIED
 *
 * `source` is a FILTER, not a boundary. Narrowing to customer-supplied gives
 * exactly the old list; the difference is that it is now the reader's choice.
 */
router.get("/orders", requireOwnerOrChecker, async (req, res) => {
  try {
    const q = str(req.query.q).toLowerCase();
    const scope = str(req.query.scope) || "all"; // all | checked | requires
    const source = str(req.query.source).toUpperCase() || "ALL";
    const [eligible, rl] = await Promise.all([qcOrders.eligibleOrders(), rollups(null)]);

    const rows = eligible
      .filter((e) => e.eligible)
      .map((e) => ({
        ...orderRow(e.mo, rl.get(String(e.mo._id))),
        materialSource: e.source.source,
        materialSourceLabel: e.source.sourceLabel,
        salesSaysJobWork: e.source.salesSaysJobWork,
        /* WHY this order is here, so a reader can tell work that is coming from
           work that is done. */
        why: e.why,
        rawItemsRequired: e.requirement.lines.size,
        requiredQuantity: r4([...e.requirement.lines.values()].reduce((n, l) => n + (l.requiredQuantity || 0), 0)),
        workOrders: e.requirement.workOrders,
      }));

    let out = rows;
    if (scope === "checked") out = out.filter((o) => o.stickers > 0);
    else if (scope === "requires") out = out.filter((o) => o.why.requires);
    if (source !== "ALL") out = out.filter((o) => o.materialSource === source);
    if (q) out = out.filter((o) => [o.moNumber, o.requestId, o.customerName].some((v) => String(v).toLowerCase().includes(q)));
    out.sort((a, b) => (b.stickers > 0) - (a.stickers > 0) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({
      success: true, orders: out, scope, source,
      counts: {
        all: rows.length,
        checked: rows.filter((o) => o.stickers > 0).length,
        requires: rows.filter((o) => o.why.requires).length,
        factoryProcured: rows.filter((o) => o.materialSource === qcOrders.SOURCE.FACTORY).length,
        customerSupplied: rows.filter((o) => o.materialSource === qcOrders.SOURCE.CUSTOMER).length,
        /* Kept so an older bundle reading `counts.jobwork` still renders a
           number rather than an empty tab count. */
        jobwork: rows.filter((o) => o.salesSaysJobWork).length,
      },
    });
  } catch (err) { console.error("[qc raw-items orders]", err); res.status(500).json({ success: false, message: err.message }); }
});

/** One order, raw item by raw item. THREE figures frame the checking, and none
 *  of them is a guess:
 *    required  what the order NEEDS — `quantityRequired` summed across the live
 *              work orders' `rawMaterials[]` allocations. Present for EVERY
 *              order, which is what makes this page work for factory-procured
 *              material (29 Sep 2026);
 *    asked     what Merchandising asked the CUSTOMER to send — the ISSUED
 *              CustomerMaterialExpectation for the order (latest revision).
 *              Customer-supplied material only;
 *    received  what the Store actually booked in as customer material — the
 *              CUSTOMER_MATERIAL goods receipts against the order (their lines'
 *              base quantity), with the ownership lots as the fallback for a
 *              receipt recorded before the GRN carried the order.
 *
 *  "TO CHECK" IS `received` WHEN THERE IS ONE, ELSE `required`, and the row says
 *  which through `expectedFrom`. The precedence is deliberate and preserves the
 *  earlier behaviour exactly for customer-supplied orders: a roll that never
 *  arrived cannot be checked, and one that arrived short is checked short, so
 *  where the arrival is known it is the better answer. Where it is not — a
 *  factory order, whose rolls are bought against a purchase order and not
 *  against this MO — the requirement is the only honest target, and before this
 *  such an order had none at all and reported nothing to check.
 *
 *  Checked / passed / defective / remaining come from the standing records. */
router.get("/orders/:moId", requireOwnerOrChecker, async (req, res) => {
  try {
    if (!isId(req.params.moId)) return res.status(400).json({ success: false, message: "Not an order id." });
    const mo = await CustomerRequest.findById(req.params.moId).select(MO_SELECT).lean();
    if (!mo) return res.status(404).json({ success: false, message: "That order was not found." });
    const refs = [mo.requestId, moNumberOf(mo)].filter(Boolean);
    const [expectation, grns, lots, records, rl, woCount, reqMap] = await Promise.all([
      CustomerMaterialExpectation.findOne({ orderRef: { $in: refs }, state: "ISSUED" }).sort({ revisionNo: -1 }).select("documentRef revisionNo lines issuedAt").lean().catch(() => null),
      /* What the Store received FOR this order: customer-supplied material, and
         (8 Oct 2026) the GRNs against Merchandising's material requests for it. */
      GoodsReceipt.find({
        status: { $ne: "VOID" },
        $or: [
          { sourceType: "CUSTOMER_MATERIAL", "customerMaterial.orderRef": { $in: refs } },
          { sourceType: "MATERIAL_REQUEST", "materialRequest.customerRequestId": mo._id },
        ],
      }).select("receiptNumber receiptDate lines").lean().catch(() => []),
      CustomerMaterialLot.find({ orderRef: { $in: refs } }).select("rawItemId variantId itemName sku baseUnit baseQuantity receiptQuantity receiptUnit receiptNumber").lean().catch(() => []),
      QCRawItemInspection.find({ manufacturingOrderId: mo._id }).sort({ inspectedAt: -1 }).lean(),
      rollups([String(mo._id)]),
      WorkOrder.countDocuments({ customerRequestId: mo._id }).catch(() => 0),
      qcOrders.requirementsByOrder([String(mo._id)]).catch(() => new Map()),
    ]);
    const keyOf = (i, v) => `${i || ""}|${v || ""}`;
    const blank = (k, seed = {}) => ({ rawItemId: k.split("|")[0], variantId: k.split("|")[1] || null, rawItemName: "", rawItemSku: "", variantLabel: "", unit: "", required: null, allocated: null, issued: null, asked: null, received: null, receipts: [], stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defects: new Map(), lastAt: null, ...seed });
    const items = new Map();
    /* required — the order's own bill of material, for every order. Seeded FIRST
       so a factory-procured order has a row per material it needs even before
       anything has been received or checked; previously such an order produced
       an empty page. */
    for (const line of (reqMap.get(String(mo._id))?.lines || new Map()).values()) {
      const k = keyOf(line.rawItemId, line.variantId);
      const cur = items.get(k) || blank(k, { rawItemName: line.rawItemName, rawItemSku: line.rawItemSku, variantLabel: line.variantLabel, unit: line.unit });
      cur.required = r4((cur.required || 0) + (line.requiredQuantity || 0));
      cur.allocated = r4((cur.allocated || 0) + (line.allocatedQuantity || 0));
      cur.issued = r4((cur.issued || 0) + (line.issuedQuantity || 0));
      items.set(k, cur);
    }
    /* asked */
    for (const l of expectation?.lines || []) {
      const k = keyOf(l.rawItemId, l.variantId);
      const cur = items.get(k) || blank(k, { rawItemName: l.rawItemName || "", rawItemSku: l.rawItemSku || l.sku || "", variantLabel: (l.variantCombination || []).join(" · ") || l.variantLabel || "", unit: l.unit || "" });
      cur.asked = r4((cur.asked || 0) + (l.requiredQuantity || 0)); if (l.shortClosedAt) cur.shortClosed = true;
      items.set(k, cur);
    }
    /* received — the GRN lines; the lots only when no receipt names the order */
    const receivedFrom = grns.length ? "grn" : lots.length ? "lots" : null;
    if (receivedFrom === "grn") {
      for (const g of grns) for (const l of g.lines || []) {
        const k = keyOf(l.rawItemId, l.variantId);
        const cur = items.get(k) || blank(k, { rawItemName: l.itemName || "", rawItemSku: l.sku || "", variantLabel: (l.variantCombination || []).join(" · "), unit: l.baseUnit || l.poUnit || "" });
        if (!cur.rawItemName) cur.rawItemName = l.itemName || ""; if (!cur.unit) cur.unit = l.baseUnit || l.poUnit || "";
        cur.received = r4((cur.received || 0) + (l.baseQuantity ?? l.receivedQuantity ?? 0));
        if (g.receiptNumber && !cur.receipts.includes(g.receiptNumber)) cur.receipts.push(g.receiptNumber);
        items.set(k, cur);
      }
    } else if (receivedFrom === "lots") {
      for (const l of lots) {
        const k = keyOf(l.rawItemId, l.variantId);
        const cur = items.get(k) || blank(k, { rawItemName: l.itemName || "", rawItemSku: l.sku || "", unit: l.baseUnit || l.receiptUnit || "" });
        if (!cur.rawItemName) cur.rawItemName = l.itemName || ""; if (!cur.unit) cur.unit = l.baseUnit || l.receiptUnit || "";
        cur.received = r4((cur.received || 0) + (l.baseQuantity ?? l.receiptQuantity ?? 0));
        if (l.receiptNumber && !cur.receipts.includes(l.receiptNumber)) cur.receipts.push(l.receiptNumber);
        items.set(k, cur);
      }
    }
    /* checked, from the records that stand */
    const live = records.filter((r) => !r.superseded);
    for (const r of live) {
      const k = keyOf(r.rawItemId, r.variantId);
      const cur = items.get(k) || blank(k, { rawItemName: r.rawItemName, rawItemSku: r.rawItemSku, variantLabel: r.variantLabel, unit: r.unit });
      if (!cur.rawItemName) cur.rawItemName = r.rawItemName; if (!cur.variantLabel) cur.variantLabel = r.variantLabel || ""; if (!cur.unit) cur.unit = r.unit || "";
      cur.stickers += 1; cur.checkedQty = r4(cur.checkedQty + r.quantity); cur.passedQty = r4(cur.passedQty + r.passedQuantity); cur.defectiveQty = r4(cur.defectiveQty + r.defectiveQuantity);
      if (!cur.lastAt || r.inspectedAt > cur.lastAt) cur.lastAt = r.inspectedAt;
      for (const d of r.defects || []) { const x = cur.defects.get(d.code) || { code: d.code, name: d.name, stickers: 0, quantity: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); cur.defects.set(d.code, x); }
      items.set(k, cur);
    }
    const rawItems = [...items.values()].map((x) => {
      /* Received when the Store booked an arrival against this order, else the
         order's own requirement. `expectedFrom` names which, because "45 m to
         check" means different things when it is what arrived and when it is
         what the order needs. */
      const received = x.received != null && x.received > 0 ? x.received : null;
      const required = x.required != null && x.required > 0 ? x.required : null;
      const expected = received != null ? received : required;
      const expectedFrom = received != null ? "received" : required != null ? "required" : null;
      const remaining = expected != null ? r4(Math.max(0, expected - x.checkedQty)) : null;
      const state = expected == null ? (x.stickers ? "checked" : x.asked != null ? "awaiting" : "none") : x.checkedQty >= expected ? "done" : x.checkedQty > 0 ? "partly" : "waiting";
      return { ...x, defects: [...x.defects.values()].sort((a, b) => b.quantity - a.quantity), expected, expectedFrom, remaining, pct: expected ? Math.min(100, Math.round((x.checkedQty / expected) * 100)) : null, shortOfAsked: x.asked != null && x.received != null ? r4(Math.max(0, x.asked - x.received)) : null, state };
    }).sort((a, b) => (b.stickers - a.stickers) || (b.expected || 0) - (a.expected || 0) || a.rawItemName.localeCompare(b.rawItemName));
    const byDefect = new Map();
    for (const r of live) for (const d of r.defects || []) { const x = byDefect.get(d.code) || { code: d.code, name: d.name, stickers: 0, quantity: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); byDefect.set(d.code, x); }
    const byChecker = new Map();
    for (const r of live) { const x = byChecker.get(r.inspectedByEmail) || { email: r.inspectedByEmail, name: r.inspectedByName, stickers: 0, quantity: 0, defective: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.quantity); x.defective += r.status === "defective" ? 1 : 0; byChecker.set(r.inspectedByEmail, x); }
    const totals = rl.get(String(mo._id)) || ZERO;
    const sum = (f) => r4(rawItems.reduce((n, x) => n + (x[f] || 0), 0));
    res.json({
      success: true,
      order: {
        ...orderRow(mo, totals),
        /* Provenance, as context. Nothing on this page is gated on it. */
        materialSource: qcOrders.orderSource(mo, { hasCustomerMaterial: grns.length > 0 || lots.length > 0 }).source,
        materialSourceLabel: qcOrders.orderSource(mo, { hasCustomerMaterial: grns.length > 0 || lots.length > 0 }).sourceLabel,
      },
      summary: { ...totals, required: sum("required"), asked: sum("asked"), received: sum("received"), expected: sum("expected"), remaining: sum("remaining"), rawItemsExpected: rawItems.filter((x) => x.expected != null).length, rawItemsAsked: rawItems.filter((x) => x.asked != null).length, rawItemsDone: rawItems.filter((x) => x.state === "done").length, workOrders: woCount, receipts: grns.length || lots.length, receivedFrom, expectation: expectation ? { documentRef: expectation.documentRef, revisionNo: expectation.revisionNo, issuedAt: expectation.issuedAt } : null },
      rawItems, byDefect: [...byDefect.values()].sort((a, b) => b.quantity - a.quantity), byChecker: [...byChecker.values()].sort((a, b) => b.stickers - a.stickers), recent: records.slice(0, 200).map(recordView),
    });
  } catch (err) { console.error("[qc raw-items order]", err); res.status(500).json({ success: false, message: err.message }); }
});

function recordView(r) {
  return { _id: r._id, date: r.date, inspectedAt: r.inspectedAt, moNumber: r.moNumber, customerName: r.customerName, manufacturingOrderId: String(r.manufacturingOrderId), barcodeId: String(r.barcodeId), rawItemName: r.rawItemName, rawItemSku: r.rawItemSku, variantLabel: r.variantLabel, quantity: r.quantity, unit: r.unit, purchaseOrderNumber: r.purchaseOrderNumber, vendorName: r.vendorName, goodsReceiptId: r.goodsReceiptId ? String(r.goodsReceiptId) : null, goodsReceiptNumber: r.goodsReceiptNumber || "", materialRequestNumber: r.materialRequestNumber || "", status: r.status, passedQuantity: r.passedQuantity, defectiveQuantity: r.defectiveQuantity, defects: r.defects || [], note: r.note || "", inspectedByName: r.inspectedByName, inspectedByEmail: r.inspectedByEmail, superseded: Boolean(r.superseded), hourKey: r.hourKey };
}

/* ── the scan ────────────────────────────────────────────────────────────── */

/**
 * The sticker's id from whatever the scanner or camera read.
 *
 * DELEGATED to the shared classifier (29 Sep 2026), which fixed a real gap: this
 * accepted `itemid=<id>`, the legacy `RawItem=<id>` and a bare 24-hex id, but NOT
 * the URL form — `https://…/store/dashboard/item-info?itemid=<id>` — which is what
 * every currently printed Store label encodes and what a phone camera hands over.
 * Camera-scanning a modern label was refused here as "not a raw item label".
 */
function stickerIdOf(raw) {
  const id = classifyQcBarcode(raw);
  return id.type === "raw_material" ? id.normalizedBarcode : null;
}
const stickerView = (b) => ({
  barcodeId: String(b._id), rawItemId: b.rawItem ? String(b.rawItem) : null, rawItemName: b.rawItemName || "—", rawItemSku: b.rawItemSku || "", variantId: b.variantId ? String(b.variantId) : null, variantLabel: (b.variantCombination || []).join(" · ") || "", variantSku: b.variantSku || "",
  quantity: r4(b.quantity), unit: b.unit || "", purchaseOrderNumber: b.purchaseOrderNumber || "", vendorName: b.vendorName || "", printedAt: b.createdAt,
  customerOrderRef: b.customerMaterial?.orderRef || "", customerLabel: b.customerMaterial?.customerLabel || "",
  goodsReceiptId: b.goodsReceiptId ? String(b.goodsReceiptId) : (b.customerMaterial?.goodsReceiptId ? String(b.customerMaterial.goodsReceiptId) : null),
  goodsReceiptNumber: b.goodsReceiptNumber || b.customerMaterial?.goodsReceiptNumber || "",
});

/**
 * Look a label up: what it is, which order it is for, and whether it was already
 * checked.
 *
 * ── `moId` IS OPTIONAL SINCE 29 SEP 2026, AND THAT IS THE WHOLE POINT ──────
 * This used to refuse every scan without one — "Choose the order first" — because
 * a factory-procured label carries no order and the code had no other way to find
 * one. It does now (services/manufacturing/qcRawItemOrders.js), so the order is
 * RESOLVED from the label, from the standing verdicts and from who needs the
 * material, and the checker is asked only when the answer is genuinely ambiguous.
 *
 * Three answers, and the caller must handle all three:
 *   order set, orderResolution "auto"    one order — carry on
 *   order null, orderResolution "choose" several — ask, then call again with moId
 *   order null, orderResolution "none"   nothing — do NOT invent one
 *
 * Passing `moId` still pins the order, which is what the chooser's second call
 * does and what a deep link from an order page does.
 */
router.post("/lookup", requireOwnerOrChecker, async (req, res) => {
  try {
    const id = stickerIdOf(req.body?.code);
    if (!id) return res.status(400).json({ success: false, code: "NOT_A_STICKER", message: "That is not a raw material label. Scan the Store's label on the material itself." });
    const b = await Barcode.findById(id).lean();
    if (!b) return res.status(404).json({ success: false, code: "UNKNOWN_STICKER", message: "No raw material with that label is on record." });

    /* The GRN the label was printed on, and the request and order it serves —
       read once, shown on the screen, written on the record (8 Oct 2026). */
    const receipt = await qcGrns.receiptOfLabel(b);

    /* An explicit order pins it; otherwise resolve. */
    let mo = null;
    let resolution = null;
    if (isId(req.body?.moId)) {
      mo = await CustomerRequest.findById(req.body.moId).select(MO_SELECT).lean();
      if (!mo) return res.status(404).json({ success: false, message: "That order was not found." });
    } else {
      resolution = await qcOrders.resolveOrdersForLabel(b, receipt);
      if (resolution.resolution === "auto") {
        mo = await CustomerRequest.findById(resolution.candidates[0].manufacturingOrderId).select(MO_SELECT).lean();
      }
    }

    const src = qcOrders.labelSource(b, receipt);

    /* No order yet: report the label and the choice, and nothing about a verdict
       — there is no order to record one against. */
    if (!mo) {
      const priors = await QCRawItemInspection.find({ barcodeId: b._id, superseded: { $ne: true } })
        .select("moNumber status inspectedAt inspectedByName").lean();
      return res.json({
        success: true,
        sticker: { ...stickerView(b), ...src },
        goodsReceipt: receipt,
        grnChoices: resolution?.grnChoices || (receipt ? [] : await qcGrns.grnsForMaterial({ rawItemId: b.rawItem, variantId: b.variantId })),
        order: null,
        orders: resolution?.candidates || [],
        orderResolution: resolution?.resolution || "none",
        orderReason: resolution?.reason || "",
        prior: null,
        warnings: priors.length ? [`Already checked on ${priors.map((p) => p.moNumber).join(", ")}.`] : [],
      });
    }

    const [onThis, elsewhere] = await Promise.all([
      QCRawItemInspection.findOne({ barcodeId: b._id, manufacturingOrderId: mo._id, superseded: { $ne: true } }).lean(),
      QCRawItemInspection.find({ barcodeId: b._id, manufacturingOrderId: { $ne: mo._id }, superseded: { $ne: true } }).select("moNumber status inspectedAt inspectedByName").lean(),
    ]);
    const warnings = [];
    const ref = b.customerMaterial?.orderRef || "";
    if (ref && ref !== mo.requestId && ref !== moNumberOf(mo)) warnings.push(`This material was received for ${ref}, not ${moNumberOf(mo)}.`);
    if (receipt?.customerRequestId && String(receipt.customerRequestId) !== String(mo._id)) warnings.push(`This label was received on ${receipt.receiptNumber} for ${receipt.orderRef || "another order"}, not ${moNumberOf(mo)}.`);
    if (!(b.quantity > 0)) warnings.push("This label shows no quantity left (it was used up).");
    if (elsewhere.length) warnings.push(`Already checked on ${elsewhere.map((e) => e.moNumber).join(", ")}.`);

    res.json({
      success: true,
      sticker: { ...stickerView(b), ...src },
      goodsReceipt: receipt,
      grnChoices: resolution?.grnChoices || (receipt ? [] : await qcGrns.grnsForMaterial({ rawItemId: b.rawItem, variantId: b.variantId })),
      order: {
        manufacturingOrderId: String(mo._id), moNumber: moNumberOf(mo), customerName: mo.customerInfo?.name || "",
        /* Descriptive. See the header — this decides nothing. */
        isJobWork: isJobWork(mo),
        ...qcOrders.orderSource(mo),
      },
      orders: resolution?.candidates || [],
      orderResolution: resolution?.resolution || "auto",
      orderReason: resolution?.reason || "",
      prior: onThis ? recordView(onThis) : null,
      warnings,
    });
  } catch (err) { console.error("[qc raw-items lookup]", err); res.status(500).json({ success: false, message: err.message }); }
});

/** Record the verdict. `recheck: true` replaces an earlier verdict for the same sticker on the same order. */
router.post("/save", requireChecker, async (req, res) => {
  try {
    const { moId, barcodeId, status, defects, defectiveQuantity, note, recheck, goodsReceiptId } = req.body || {};
    if (!isId(moId)) return res.status(400).json({ success: false, message: "Choose the order first." });
    if (!isId(barcodeId)) return res.status(400).json({ success: false, message: "Scan the raw item first." });
    if (!["passed", "defective"].includes(status)) return res.status(400).json({ success: false, message: "Pass the raw item, or mark a defect." });
    const [b, mo, who] = await Promise.all([Barcode.findById(barcodeId).lean(), CustomerRequest.findById(moId).select(MO_SELECT).lean(), whoAmI(req)]);
    if (!b) return res.status(404).json({ success: false, message: "No raw item with that label is on record." });
    let receipt = await qcGrns.receiptOfLabel(b);
    /* ── A GOODS RECEIPT THE CHECKER CHOSE (8 Oct 2026, owner) ────────────────
       A label printed from stock names no receipt. The checker picks, from
       the material-request GRNs carrying this material, the one the roll
       belongs to; the verdict is recorded against it AND the label is linked
       to it, so the next scan of the same label resolves on its own. A label
       that already names a receipt keeps it — the choice never overrides. */
    let linkLabel = false;
    if (!receipt && isId(goodsReceiptId)) {
      const choices = await qcGrns.grnsForMaterial({ rawItemId: b.rawItem, variantId: b.variantId });
      const chosen = choices.find((c) => c.goodsReceiptId === String(goodsReceiptId));
      if (!chosen) return res.status(400).json({ success: false, code: "GRN_NOT_FOR_MATERIAL", message: "That goods receipt carries no line for this raw item and variant, so the label cannot be linked to it." });
      receipt = await qcGrns.receiptById(goodsReceiptId, b);
      linkLabel = Boolean(receipt);
    }
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
      if (unknown.length) return res.status(400).json({ success: false, message: `Unknown reason${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. The owner defines them under Setup \u203a Raw-material QC.` });
      picked = codes.map((c) => ({ code: c, name: byCode.get(c).name, category: byCode.get(c).category || "" }));
      defQty = defectiveQuantity === undefined || defectiveQuantity === null || defectiveQuantity === "" ? qty : r4(defectiveQuantity);
      if (!(defQty > 0) || defQty > qty) return res.status(400).json({ success: false, message: `The defective quantity must be between 0 and ${qty} ${b.unit || ""}.`.trim() });
      if (codes.includes("OTHER") && !str(note)) return res.status(400).json({ success: false, message: "Write what the problem is when the reason is Other." });
    }
    const prior = await QCRawItemInspection.findOne({ barcodeId: b._id, manufacturingOrderId: mo._id, superseded: { $ne: true } });
    if (prior && !recheck) return res.status(409).json({ success: false, code: "ALREADY_CHECKED", message: `This raw item was already ${prior.status} on ${moNumberOf(mo)} by ${prior.inspectedByName || "QC"}. Check it again to replace that verdict.`, prior: recordView(prior) });

    // A check kept on a device while the server was down carries when it was made.
    const now = boundedRecordedAt(req.body?.recordedAt);
    const doc = await QCRawItemInspection.create({
      date: shift.istDayKeyOf(now), hourKey: shift.shiftBuckets()[shift.bucketIndexOf(now)]?.key || "",
      manufacturingOrderId: mo._id, moNumber: moNumberOf(mo), customerName: mo.customerInfo?.name || "", isJobWork: isJobWork(mo),
      barcodeId: b._id, rawItemId: b.rawItem || null, rawItemName: b.rawItemName || "", rawItemSku: b.rawItemSku || "", variantId: b.variantId || null, variantLabel: (b.variantCombination || []).join(" · "), quantity: qty, unit: b.unit || "", purchaseOrderNumber: b.purchaseOrderNumber || "", vendorName: b.vendorName || "",
      /* the GRN the label was received under (8 Oct 2026), so the GRN book can
         say how much of each receipt is checked */
      goodsReceiptId: receipt ? receipt.goodsReceiptId : null, goodsReceiptNumber: receipt?.receiptNumber || "",
      goodsReceiptLineId: b.goodsReceiptLineId || b.customerMaterial?.goodsReceiptLineId || receipt?.line?.goodsReceiptLineId || null,
      materialRequestId: receipt?.requestId || null, materialRequestNumber: receipt?.requestNumber || "",
      status, passedQuantity: status === "passed" ? qty : r4(qty - defQty), defectiveQuantity: status === "passed" ? 0 : defQty, defects: picked, note: str(note).slice(0, 500),
      inspectedByEmail: who.email, inspectedByName: who.name, inspectedByBiometricId: who.biometricId, inspectedAt: now,
    });
    if (prior) { prior.superseded = true; prior.supersededById = doc._id; prior.supersededAt = now; await prior.save(); }
    if (linkLabel && !b.goodsReceiptId) {
      await Barcode.updateOne({ _id: b._id, goodsReceiptId: null }, { $set: { goodsReceiptId: receipt.goodsReceiptId, goodsReceiptNumber: receipt.receiptNumber, goodsReceiptLineId: receipt.line?.goodsReceiptLineId || null } });
    }
    const rl = (await rollups([String(mo._id)])).get(String(mo._id)) || ZERO;
    res.status(201).json({ success: true, record: recordView(doc), replaced: prior ? String(prior._id) : null, orderTotals: rl, goodsReceipt: receipt, labelLinked: linkLabel, message: status === "passed" ? `Passed: ${qty} ${b.unit || ""} of ${b.rawItemName}.` : `Defect marked on ${b.rawItemName}: ${defQty} ${b.unit || ""} defective, ${r4(qty - defQty)} passed.` });
  } catch (err) { console.error("[qc raw-items save]", err); res.status(500).json({ success: false, message: err.message }); }
});

/* ── the GRN book (8 Oct 2026) ───────────────────────────────────────────── */

/**
 * Every material-request GRN with its raw-material QC standing — the list the
 * QC Orders page shows beside the manufacturing orders. `q`, `status`
 * (all | not-started | in-progress | complete | defects) and `customer` narrow it.
 */
router.get("/grns", requireOwnerOrChecker, async (req, res) => {
  try {
    const out = await qcGrns.listGrns({ q: str(req.query.q), status: str(req.query.status) || "all", customer: str(req.query.customer) });
    res.json({ success: true, ...out });
  } catch (err) { console.error("[qc raw-items grns]", err); res.status(500).json({ success: false, message: err.message }); }
});

/** One GRN: each line's received quantity against what QC has checked, every label and its verdict, every record. */
router.get("/grns/:grnId", requireOwnerOrChecker, async (req, res) => {
  try {
    const d = await qcGrns.grnDetail(req.params.grnId);
    if (!d) return res.status(404).json({ success: false, message: "No material-request goods receipt with that id is on record." });
    res.json({ success: true, ...d });
  } catch (err) { console.error("[qc raw-items grn]", err); res.status(500).json({ success: false, message: err.message }); }
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
/** The owner's export (29 Sep 2026: hour-wise, day-wise and order-wise in one
 *  answer). `from`/`to` bound the days (default the last 7); `moId` narrows
 *  to one order over ALL time (the order page's export); `email` narrows to
 *  one checker. `days[]` carries each day's shift-hour buckets so a
 *  workbook can lay hours out one column per day. */
router.get("/report", requireOwner, async (req, res) => {
  try {
    const today = shift.istDayKeyOf(new Date());
    const forOrder = isId(req.query.moId) ? oid(req.query.moId) : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(str(req.query.to)) ? str(req.query.to) : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(str(req.query.from)) ? str(req.query.from) : forOrder ? "2000-01-01" : new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
    const match = { date: { $gte: from, $lte: to }, superseded: { $ne: true } };
    if (forOrder) match.manufacturingOrderId = forOrder;
    if (str(req.query.email) && str(req.query.email) !== "all") match.inspectedByEmail = str(req.query.email).toLowerCase();
    const records = await QCRawItemInspection.find(match).sort({ inspectedAt: -1 }).lean();
    const buckets = shift.shiftBuckets();
    const perDay = new Map();
    for (const r of records) { if (!perDay.has(r.date)) perDay.set(r.date, []); perDay.get(r.date).push(r); }
    const days = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, rows]) => { const sh = dayShape(rows, buckets); return { date, hours: sh.hours, totals: sh.totals, byOrder: sh.byOrder }; });
    const byDay = new Map(); const byChecker = new Map();
    for (const r of records) {
      const d = byDay.get(r.date) || { date: r.date, stickers: 0, quantity: 0, passed: 0, defective: 0, checkers: new Set() };
      d.stickers += 1; d.quantity = r4(d.quantity + r.quantity); d.passed = r4(d.passed + r.passedQuantity); d.defective = r4(d.defective + r.defectiveQuantity); d.checkers.add(r.inspectedByEmail); byDay.set(r.date, d);
      const c = byChecker.get(r.inspectedByEmail) || { email: r.inspectedByEmail, name: r.inspectedByName, stickers: 0, quantity: 0, passed: 0, defective: 0, days: new Set() };
      c.stickers += 1; c.quantity = r4(c.quantity + r.quantity); c.passed = r4(c.passed + r.passedQuantity); c.defective = r4(c.defective + r.defectiveQuantity); c.days.add(r.date); byChecker.set(r.inspectedByEmail, c);
    }
    const shape = dayShape(records, buckets);
    res.json({ success: true, from, to, moId: forOrder ? String(forOrder) : null, email: str(req.query.email) || "all", shift: shift.SHIFT, days, records: records.slice(0, 5000).map(recordView), ...shape, byDay: [...byDay.values()].map((d) => ({ ...d, checkers: d.checkers.size })).sort((a, b) => a.date.localeCompare(b.date)), byChecker: [...byChecker.values()].map((c) => ({ ...c, days: c.days.size })).sort((a, b) => b.stickers - a.stickers), recent: records.slice(0, 100).map(recordView) });
  } catch (err) { console.error("[qc raw-items report]", err); res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
