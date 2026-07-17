// routes/CMS_Routes/PM/pmRequestsRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const MRF = require("../../../models/CMS_Models/Inventory/Operations/MRF");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../models/CMS_Models/Inventory/Configurations/Unit");
const NotificationService = require("../../../services/NotificationService");

async function convertQty(qty, fromUnit, toUnit) {
  if (qty == null || !fromUnit || !toUnit || fromUnit === toUnit) return qty;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit }).populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const d = (fromDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === toUnit);
      if (d?.quantity) return qty * d.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit }).populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const r = (toDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === fromUnit);
      if (r?.quantity) return qty / r.quantity;
    }
    return qty;
  } catch { return qty; }
}
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

const getActorId = (req) => req.user._id || req.user.id;
const STORE_VISIBLE_STATUSES = ["quotation_sales_approved", "in_progress", "completed"];

// ═════════════════════════════════════════════════════════════════════
// GET /  — merged list: MO requests + MRFs (SELF + BYPASS)
// ═════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const [mrfs, moRequests] = await Promise.all([
      MRF.find({})
        .select("mrfNumber requestedForName requestedForDept requestedForId creationMode createdByName requestType deadline reason priority status items pmApproved pmApprovedAt pmRejected pmRejectedAt pmRejectionNote createdAt")
        .sort({ createdAt: -1 }).lean(),
      CustomerRequest.find({ status: { $in: STORE_VISIBLE_STATUSES } })
        .select("requestId customerInfo status priority requestType items pmApproved pmApprovedAt pmRejected pmRejectedAt pmRejectionNote createdAt")
        .sort({ createdAt: -1 }).lean(),
    ]);

    const moIds = moRequests.map(r => r._id);
    const woStats = moIds.length ? await WorkOrder.aggregate([
      { $match: { customerRequestId: { $in: moIds } } },
      { $group: { _id: "$customerRequestId", totalWOs: { $sum: 1 }, totalQty: { $sum: "$quantity" } } },
    ]) : [];
    const woMap = new Map(woStats.map(s => [s._id.toString(), s]));

    const mo = moRequests.map(r => {
      const s = woMap.get(r._id.toString()) || { totalWOs: 0, totalQty: 0 };
      return {
        _type: "mo", _id: r._id, number: r.requestId,
        requesterName: r.customerInfo?.name || "—",
        requesterSub: r.customerInfo?.organizationName || "",
        priority: r.priority || "", status: r.status,
        itemsCount: r.items?.length || 0,
        totalWOs: s.totalWOs, totalQty: s.totalQty,
        pmApproved: !!r.pmApproved, pmApprovedAt: r.pmApprovedAt || null,
        pmRejected: !!r.pmRejected, pmRejectedAt: r.pmRejectedAt || null,
        pmRejectionNote: r.pmRejectionNote || "",
        createdAt: r.createdAt,
      };
    }).filter(r => r.totalWOs > 0);

    const mrf = mrfs.map(m => ({
      _type: "mrf", _id: m._id, number: m.mrfNumber,
      requesterName: m.requestedForName || "—",
      requesterSub: m.requestedForDept || "",
      requesterId: m.requestedForId || "",
      creationMode: m.creationMode, createdByName: m.createdByName || "",
      requestType: m.requestType, deadline: m.deadline || null,
      reason: m.reason || "", priority: m.priority || "", status: m.status,
      itemsCount: m.items?.length || 0,
      items: (m.items || []).map(i => ({
        rawItemName: i.rawItemName, rawItemSku: i.rawItemSku,
        variantCombination: i.variantCombination || [],
        requestedQty: i.requestedQty, unit: i.unit, itemStatus: i.itemStatus,
      })),
      pmApproved: !!m.pmApproved, pmApprovedAt: m.pmApprovedAt || null,
      pmRejected: !!m.pmRejected, pmRejectedAt: m.pmRejectedAt || null,
      pmRejectionNote: m.pmRejectionNote || "",
      createdAt: m.createdAt,
    }));

    const requests = [...mo, ...mrf]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, requests });
  } catch (e) {
    console.error("[PM requests list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// GET /mrf/:id  — MRF detail with live stock
// ═════════════════════════════════════════════════════════════════════
router.get("/mrf/:id", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
      .populate("requestedFor", "firstName middleName lastName name department email designation biometricId")
      .populate("pmApprovedBy", "name")
      .populate("pmRejectedBy", "name")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });

    const ids = [...new Set((mrf.items || []).map(i => i.rawItem?.toString()).filter(Boolean))];
    const docs = ids.length
      ? await RawItem.find({ _id: { $in: ids } }).select("quantity minStock variants._id variants.quantity").lean()
      : [];
    const map = new Map(docs.map(d => [d._id.toString(), d]));

    const enriched = [];
    for (const it of (mrf.items || [])) {
      const doc = map.get(it.rawItem?.toString());
      let available = null; // in the raw item's native/base unit
      if (doc) {
        if (it.variantId && doc.variants?.length) {
          const v = doc.variants.find(vv => vv._id?.toString() === it.variantId?.toString());
          if (v) available = v.quantity || 0;
        }
        if (available === null) available = doc.quantity || 0;
      }
      // Convert stock into the unit the requester used
      let availableInUnit = available;
      if (available !== null && it.baseUnit && it.unit && it.baseUnit !== it.unit) {
        availableInUnit = await convertQty(available, it.baseUnit, it.unit);
      }
      const shortage = availableInUnit !== null
        ? Math.max(0, (it.requestedQty || 0) - availableInUnit)
        : null;
      enriched.push({ ...it, available, availableInUnit, shortage });
    }
    mrf.items = enriched;

    res.json({ success: true, mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════
// GET /mo/:id  — MO request detail + work orders
// ═════════════════════════════════════════════════════════════════════
router.get("/mo/:id", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.id).lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const workOrders = await WorkOrder.find({ customerRequestId: req.params.id })
      .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity storeDepartmentVerified")
      .sort({ createdAt: 1 }).lean();
    res.json({ success: true, request, workOrders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════
// PATCH /mrf/:id/approve  — PM approval (this IS the approval now)
// ═════════════════════════════════════════════════════════════════════
router.patch("/mrf/:id/approve", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (mrf.pmApproved) return res.json({ success: true, message: "Already PM-approved", mrf });
    if (["REJECTED", "CANCELLED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot approve — status is ${mrf.status}` });

    mrf.pmApproved = true;
    mrf.pmApprovedBy = getActorId(req);
    mrf.pmApprovedAt = new Date();
    mrf.pmRejected = false; mrf.pmRejectedBy = null; mrf.pmRejectedAt = null; mrf.pmRejectionNote = "";

    // Advance the store status machine so issuance can proceed
    if (mrf.status === "PENDING") {
      mrf.status = "APPROVED";
      mrf.approvedBy = getActorId(req);
      mrf.approvedAt = new Date();
      mrf.items.forEach(i => { if (i.itemStatus === "PENDING") i.itemStatus = "APPROVED"; });
    }

    await mrf.save();
    NotificationService.sendToRole(["store_manager", "admin"], {
      title: "MRF Approved by PM",
      body: `${mrf.mrfNumber} — ${mrf.requestedForName}. Issue the materials now.`,
      url: `/store/dashboard/order-requests/mrf/${mrf._id}`,
      tag: `mrf-${mrf._id}`,
    }).catch(() => {});
    res.json({ success: true, message: "MRF approved", mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════
// PATCH /mrf/:id/reject
// ═════════════════════════════════════════════════════════════════════
router.patch("/mrf/:id/reject", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (["ISSUED", "PARTIALLY_ISSUED", "PARTIALLY_RETURNED", "COMPLETED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: "Cannot reject — materials already issued" });

    mrf.pmRejected = true;
    mrf.pmRejectedBy = getActorId(req);
    mrf.pmRejectedAt = new Date();
    mrf.pmRejectionNote = req.body.note || "";
    mrf.pmApproved = false;

    mrf.status = "REJECTED";
    mrf.rejectedBy = getActorId(req);
    mrf.rejectedAt = new Date();
    mrf.rejectionNote = req.body.note || "Rejected by PM";
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED"; });

    await mrf.save();
    NotificationService.sendToRole(["store_manager", "admin"], {
      title: "MRF Rejected by PM",
      body: `${mrf.mrfNumber} — ${mrf.requestedForName}.${req.body.note ? ` Reason: ${req.body.note}` : ""}`,
      url: `/store/dashboard/order-requests/mrf/${mrf._id}`,
      tag: `mrf-${mrf._id}`,
    }).catch(() => {});

    if (mrf.requestedFor) {
      NotificationService.sendToUser(mrf.requestedFor, {
        title: "Request Rejected",
        body: `Your material request ${mrf.mrfNumber} was rejected.${req.body.note ? ` Reason: ${req.body.note}` : ""}`,
        type: "request",
        url: "/coworking",
        tag: `mrf-${mrf._id}`,
      }).catch(() => {});
    }

    res.json({ success: true, message: "MRF rejected", mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════
// PATCH /mo/:id/approve  — flag only; does NOT touch MO status machine
// ═════════════════════════════════════════════════════════════════════
router.patch("/mo/:id/approve", async (req, res) => {
  try {
    const r = await CustomerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Request not found" });
    r.pmApproved = true;
    r.pmApprovedBy = getActorId(req);
    r.pmApprovedAt = new Date();
    r.pmRejected = false; r.pmRejectedBy = null; r.pmRejectedAt = null; r.pmRejectionNote = "";
    await r.save();
    res.json({ success: true, message: "MO request PM-approved", request: r });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════
// PATCH /mo/:id/reject  — flag only; does NOT cancel the MO or its WOs
// ═════════════════════════════════════════════════════════════════════
router.patch("/mo/:id/reject", async (req, res) => {
  try {
    const r = await CustomerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Request not found" });
    r.pmRejected = true;
    r.pmRejectedBy = getActorId(req);
    r.pmRejectedAt = new Date();
    r.pmRejectionNote = req.body.note || "";
    r.pmApproved = false;
    await r.save();
    res.json({ success: true, message: "MO request PM-rejected", request: r });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;