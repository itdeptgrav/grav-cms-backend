"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

function ceoAuth(req, res, next) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
    const d = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res.status(403).json({ success: false, message: "CEO access required" });
    req.ceoUser = d;
    next();
  } catch { return res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

const istDateString = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split("T")[0];
};

router.get("/defects", ceoAuth, async (req, res) => {
  try {
    const DefectRecord = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");
    const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    const Employee = require("../../models/Employee");

    const { date, startDate, endDate } = req.query;
    const filter = {};
    if (date) filter.date = date;
    else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate) filter.date.$lte = endDate;
    } else {
      filter.date = istDateString();
    }

    const defects = await DefectRecord.find(filter).sort({ markedAt: -1 }).lean();
    if (!defects.length) return res.json({ success: true, defects: [], total: 0, byOperator: {} });

    // ── Load WorkOrders ───────────────────────────────────────────────────────
    const woIds = [...new Set(defects.map(d => d.workOrderId).filter(Boolean).map(String))];
    const wos = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber operations stockItemName stockItemReference variantAttributes stockItemId customerRequestId")
      .lean();
    const woMap = new Map(wos.map(w => [w._id.toString(), w]));

    // ── Load StockItems ───────────────────────────────────────────────────────
    const siIds = [...new Set(wos.map(w => w.stockItemId).filter(Boolean).map(String))];
    const siDocs = await StockItem.find({ _id: { $in: siIds } })
      .select("name genderCategory category reference images variants").lean();
    const siMap = new Map(siDocs.map(s => [s._id.toString(), s]));

    // ── Load CustomerRequests (MO info) ───────────────────────────────────────
    const crIds = [...new Set(wos.map(w => w.customerRequestId).filter(Boolean).map(String))];
    const crDocs = await CustomerRequest.find({ _id: { $in: crIds } })
      .select("requestId customerInfo requestType status").lean();
    const crMap = new Map(crDocs.map(m => [m._id.toString(), m]));

    // ── Load Employees to resolve operator IDs → real names ──────────────────
    // DefectRecord stores operatorId (e.g. "GR0058") and operatorName (may also be "GR0058")
    const opIdSet = new Set();
    defects.forEach(d => {
      if (d.operatorId) opIdSet.add(d.operatorId);
      if (d.operatorIdentityId) opIdSet.add(d.operatorIdentityId);
      // If operatorName looks like an ID (GR0012 etc.) treat it as an ID too
      if (d.operatorName && /^GR\d+/i.test(d.operatorName)) opIdSet.add(d.operatorName);
    });
    const opIds = [...opIdSet];

    const empDocs = opIds.length > 0
      ? await Employee.find({
        $or: [
          { identityId: { $in: opIds } },
          { biometricId: { $in: opIds } },
        ]
      }).select("firstName lastName identityId biometricId profilePhoto").lean()
      : [];

    // Map: any ID → { name, profilePhoto }
    const empMap = new Map();
    empDocs.forEach(e => {
      const name = [e.firstName, e.lastName].filter(Boolean).join(" ").trim();
      const entry = { name, profilePhoto: e.profilePhoto || null };
      if (e.identityId) empMap.set(e.identityId, entry);
      if (e.biometricId && e.biometricId !== e.identityId) empMap.set(e.biometricId, entry);
    });

    // ── Resolve product info (image + genderCategory) ─────────────────────────
    const resolveProductInfo = (wo) => {
      if (!wo) return { image: null, genderCategory: null, category: null };
      const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
      if (!si) return { image: null, genderCategory: null, category: null };
      let image = null;
      if (wo.variantAttributes && wo.variantAttributes.length && si.variants && si.variants.length) {
        const match = si.variants.find(v =>
          (v.attributes || []).every(va =>
            wo.variantAttributes.some(woA =>
              woA.name && va.name &&
              woA.name.toLowerCase() === va.name.toLowerCase() &&
              String(woA.value).toLowerCase() === String(va.value).toLowerCase()
            )
          )
        );
        if (match && match.images && match.images[0]) image = match.images[0];
      }
      if (!image && si.images && si.images[0]) image = si.images[0];
      return { image, genderCategory: si.genderCategory || null, category: si.category || null };
    };

    // ── Build enriched response ───────────────────────────────────────────────
    const enriched = defects.map(d => {
      const wo = d.workOrderId ? woMap.get(d.workOrderId.toString()) : null;
      const cr = wo && wo.customerRequestId ? crMap.get(wo.customerRequestId.toString()) : null;
      const pInfo = resolveProductInfo(wo);

      // Resolve operator: try all possible ID fields against Employee DB
      const rawId = d.operatorId || d.operatorIdentityId || "";
      const rawName = d.operatorName || "";
      const isIdLike = /^GR\d+/i.test(rawName);

      // Look up by stored operatorId first, then by operatorName if it looks like an ID
      const empEntry = empMap.get(rawId) || empMap.get(rawName) || null;
      const resolvedName = empEntry
        ? empEntry.name
        : (isIdLike ? rawId : rawName) || rawId || "Unknown";
      const resolvedId = rawId || (isIdLike ? rawName : "");

      // Operation code → readable name lookup from WO operations
      const opLookup = new Map();
      (wo && wo.operations ? wo.operations : []).forEach(op => {
        if (op.operationCode) opLookup.set(op.operationCode.trim().toLowerCase(), op.operationType || "");
      });

      return Object.assign({}, d, {
        workOrderNumber: wo ? wo.workOrderNumber : ("WO-" + d.workOrderShortId),
        productName: wo ? (wo.stockItemName || "Unknown Product") : "Unknown Product",
        stockItemReference: wo ? (wo.stockItemReference || null) : null,
        variantAttributes: wo ? (wo.variantAttributes || []) : [],
        productImage: pInfo.image,
        genderCategory: pInfo.genderCategory,
        category: pInfo.category,
        moNumber: cr ? ("MO-" + cr.requestId) : null,
        customerName: cr && cr.customerInfo ? cr.customerInfo.name : null,
        requestType: cr ? (cr.requestType || null) : null,
        // Resolved operator with real name
        operatorName: resolvedName,
        operatorId: resolvedId,
        operatorPhoto: empEntry ? empEntry.profilePhoto : null,
        operations: (d.operations || []).map(c => ({
          code: c,
          name: opLookup.get(c.trim().toLowerCase()) || "",
        })),
      });
    });

    const byOperator = {};
    enriched.forEach(d => {
      const key = d.operatorName || d.operatorId || "Unknown";
      byOperator[key] = (byOperator[key] || 0) + 1;
    });

    res.json({ success: true, defects: enriched, total: enriched.length, byOperator });
  } catch (err) {
    console.error("[CEO QC] /defects:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

module.exports = router;