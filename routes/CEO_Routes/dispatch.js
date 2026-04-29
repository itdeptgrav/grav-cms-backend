/**
 * routes/CEO_Routes/dispatch.js
 *
 * CEO-side Dispatch & Packaging endpoint.
 * Fetches from existing packaging/dispatch routes and enriches with:
 *   - productImage (from StockItem, variant-matched)
 *   - genderCategory, category (from StockItem)
 *
 * Register in server.js:
 *   const ceoDispatchRoutes = require("./routes/CEO_Routes/dispatch");
 *   app.use("/api/ceo/dispatch", ceoDispatchRoutes);
 *
 * Endpoints:
 *   GET /api/ceo/dispatch/packaging?from=&to=&type=&limit=
 *   GET /api/ceo/dispatch/dispatched?from=&to=&limit=
 */

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

// ── Image resolver (variant-matched) ─────────────────────────────────────────
function resolveImage(si, variantAttributes) {
  if (!si) return null;
  if (variantAttributes?.length && si.variants?.length) {
    const match = si.variants.find(v =>
      (v.attributes || []).every(va =>
        variantAttributes.some(woA =>
          woA.name?.toLowerCase() === va.name?.toLowerCase() &&
          String(woA.value).toLowerCase() === String(va.value).toLowerCase()
        )
      )
    );
    if (match?.images?.[0]) return match.images[0];
  }
  return si.images?.[0] || null;
}

// ── Enrich logs with StockItem info ──────────────────────────────────────────
async function enrichLogs(logs) {
  if (!logs.length) return logs;

  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

  // Strategy 1: look up by workOrderId (ObjectId) if stored on the log
  const woIds = [...new Set(logs.map(l => l.workOrderId?.toString?.()).filter(Boolean))];
  // Strategy 2: look up by workOrderNumber string
  const woNumbers = [...new Set(logs.map(l => l.workOrderNumber).filter(Boolean))];

  const [wosByIdDocs, wosByNumDocs] = await Promise.all([
    woIds.length > 0 ? WorkOrder.find({ _id: { $in: woIds } }).select("workOrderNumber stockItemId variantAttributes stockItemReference").lean() : [],
    woNumbers.length > 0 ? WorkOrder.find({ workOrderNumber: { $in: woNumbers } }).select("workOrderNumber stockItemId variantAttributes stockItemReference").lean() : [],
  ]);

  const woById = new Map(wosByIdDocs.map(w => [w._id.toString(), w]));
  const woByNumber = new Map([...wosByIdDocs, ...wosByNumDocs].map(w => [w.workOrderNumber, w]));

  // Collect all stockItemIds found
  const allWOs = [...wosByIdDocs, ...wosByNumDocs];
  const directSiIds = logs.map(l => l.stockItemId?.toString?.()).filter(Boolean);
  const siIds = [...new Set([...allWOs.map(w => w.stockItemId).filter(Boolean).map(String), ...directSiIds])];

  // Strategy 3: if still no siIds, try matching by stockItemName
  let siByName = new Map();
  if (siIds.length === 0) {
    const stockNames = [...new Set(logs.map(l => l.stockItemName).filter(Boolean))];
    if (stockNames.length > 0) {
      const siByNameDocs = await StockItem.find({ name: { $in: stockNames } })
        .select("name genderCategory category images variants reference").lean();
      siByNameDocs.forEach(si => siByName.set(si.name, si));
    }
  }

  const stockItems = siIds.length > 0
    ? await StockItem.find({ _id: { $in: siIds } })
      .select("name genderCategory category images variants reference").lean()
    : [];
  const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));

  return logs.map(log => {
    // Find WorkOrder: try by ID first, then by number
    const wo = (log.workOrderId ? woById.get(log.workOrderId.toString()) : null)
      || woByNumber.get(log.workOrderNumber);
    // Find StockItem: try by ID, then by name fallback
    const siId = log.stockItemId?.toString?.() || wo?.stockItemId?.toString?.();
    const si = (siId ? siMap.get(siId) : null) || siByName.get(log.stockItemName) || null;
    const variants = log.variantAttributes?.length ? log.variantAttributes : (wo?.variantAttributes || []);
    return {
      ...log,
      productImage: resolveImage(si, variants),
      genderCategory: si?.genderCategory || null,
      category: si?.category || null,
      variantAttributes: variants,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/dispatch/packaging?from=YYYY-MM-DD&to=YYYY-MM-DD&type=all|person_wise|bulk&limit=200
// Packaging events — what has been packed and when
// ─────────────────────────────────────────────────────────────────────────────
router.get("/packaging", ceoAuth, async (req, res) => {
  try {
    const { from, to, type = "all", limit = 500 } = req.query;
    const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

    // Packaging data lives in WorkOrder.packagingRecords[]
    // Filter WOs that have packaging records in the date range
    const woFilter = { "packagingRecords.0": { $exists: true } };
    const wos = await WorkOrder.find(woFilter)
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes customerRequestId quantity packagingRecords")
      .lean();

    // Flatten packagingRecords → individual log events, filtered by date/type
    const fromDate = from ? new Date(from + "T00:00:00.000Z") : null;
    const toDate = to ? new Date(to + "T23:59:59.999Z") : null;

    let allLogs = [];
    for (const wo of wos) {
      for (const rec of wo.packagingRecords || []) {
        const recDate = rec.packagedAt ? new Date(rec.packagedAt) : null;
        if (fromDate && recDate && recDate < fromDate) continue;
        if (toDate && recDate && recDate > toDate) continue;
        if (type && type !== "all" && rec.packagingType !== type) continue;
        allLogs.push({
          workOrderId: wo._id.toString(),
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          stockItemId: wo.stockItemId?.toString(),
          stockItemReference: wo.stockItemReference,
          variantAttributes: wo.variantAttributes || [],
          customerRequestId: wo.customerRequestId?.toString(),
          totalQuantity: wo.quantity,
          packagedQuantity: rec.packagedQuantity,
          packagingType: rec.packagingType || "bulk",
          packagedAt: rec.packagedAt,
          packagedBy: rec.packagedBy || "",
          employeeNames: rec.employeeNames || [],
          notes: rec.notes || "",
        });
      }
    }

    // Sort newest first, limit
    allLogs.sort((a, b) => new Date(b.packagedAt || 0) - new Date(a.packagedAt || 0));
    allLogs = allLogs.slice(0, parseInt(limit));

    // Enrich with StockItem images + genderCategory + MO info
    const siIds = [...new Set(allLogs.map(l => l.stockItemId).filter(Boolean))];
    const crIds = [...new Set(allLogs.map(l => l.customerRequestId).filter(Boolean))];

    const [stockItems, crs] = await Promise.all([
      siIds.length > 0 ? StockItem.find({ _id: { $in: siIds } }).select("name genderCategory category images variants reference").lean() : [],
      crIds.length > 0 ? CustomerRequest.find({ _id: { $in: crIds } }).select("requestId customerInfo requestType").lean() : [],
    ]);

    const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));
    const crMap = new Map(crs.map(cr => [cr._id.toString(), cr]));

    const enriched = allLogs.map(log => {
      const si = log.stockItemId ? siMap.get(log.stockItemId) : null;
      const cr = log.customerRequestId ? crMap.get(log.customerRequestId) : null;
      return {
        ...log,
        productImage: resolveImage(si, log.variantAttributes),
        genderCategory: si?.genderCategory || null,
        category: si?.category || null,
        moNumber: cr ? `MO-${cr.requestId}` : null,
        customerName: cr?.customerInfo?.name || null,
        requestType: cr?.requestType || null,
      };
    });

    const totalUnits = enriched.reduce((s, l) => s + (l.packagedQuantity || 0), 0);
    const personWise = enriched.filter(l => l.packagingType === "person_wise").length;
    const bulk = enriched.filter(l => l.packagingType === "bulk").length;

    res.json({
      success: true,
      logs: enriched,
      total: enriched.length,
      totals: { totalUnits, personWiseCount: personWise, bulkCount: bulk },
    });
  } catch (err) {
    console.error("[CEO Dispatch] /packaging:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/dispatch/dispatched?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=200
// Dispatch events — what has actually been dispatched to customers
// Reads from WorkOrder.dispatchRecords[]
// ─────────────────────────────────────────────────────────────────────────────
router.get("/dispatched", ceoAuth, async (req, res) => {
  try {
    const { from, to, limit = 200 } = req.query;
    const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
    const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

    // Find WOs with dispatch records in the date range
    const woFilter = { "dispatchRecords.0": { $exists: true } };
    const wos = await WorkOrder.find(woFilter)
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes customerRequestId quantity productionCompletion dispatchedQuantity dispatchRecords")
      .lean();

    // Filter dispatch records by date range
    const fromDate = from ? new Date(from + "T00:00:00.000Z") : null;
    const toDate = to ? new Date(to + "T23:59:59.999Z") : null;

    let allDispatchEvents = [];
    for (const wo of wos) {
      for (const rec of wo.dispatchRecords || []) {
        const recDate = rec.dispatchedAt ? new Date(rec.dispatchedAt) : null;
        if (fromDate && recDate && recDate < fromDate) continue;
        if (toDate && recDate && recDate > toDate) continue;
        allDispatchEvents.push({
          workOrderId: wo._id.toString(),
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          stockItemId: wo.stockItemId?.toString(),
          stockItemReference: wo.stockItemReference,
          variantAttributes: wo.variantAttributes || [],
          customerRequestId: wo.customerRequestId?.toString(),
          totalQuantity: wo.quantity,
          completedQuantity: wo.productionCompletion?.overallCompletedQuantity || 0,
          totalDispatched: wo.dispatchedQuantity || 0,
          dispatchedQuantity: rec.dispatchedQuantity,
          dispatchedAt: rec.dispatchedAt,
          dispatchedBy: rec.dispatchedBy,
          dispatchType: rec.dispatchType || "bulk",
          employeeNames: rec.employeeNames || [],
          notes: rec.notes || "",
        });
      }
    }

    // Sort newest first, limit
    allDispatchEvents.sort((a, b) => new Date(b.dispatchedAt || 0) - new Date(a.dispatchedAt || 0));
    allDispatchEvents = allDispatchEvents.slice(0, parseInt(limit));

    // Load StockItem images + MO info
    const siIds = [...new Set(allDispatchEvents.map(e => e.stockItemId).filter(Boolean))];
    const crIds = [...new Set(allDispatchEvents.map(e => e.customerRequestId).filter(Boolean))];

    const [stockItems, customerRequests] = await Promise.all([
      siIds.length > 0 ? StockItem.find({ _id: { $in: siIds } }).select("name genderCategory category images variants reference").lean() : [],
      crIds.length > 0 ? CustomerRequest.find({ _id: { $in: crIds } }).select("requestId customerInfo requestType").lean() : [],
    ]);

    const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));
    const crMap = new Map(customerRequests.map(cr => [cr._id.toString(), cr]));

    const enriched = allDispatchEvents.map(e => {
      const si = e.stockItemId ? siMap.get(e.stockItemId) : null;
      const cr = e.customerRequestId ? crMap.get(e.customerRequestId) : null;
      return {
        ...e,
        productImage: resolveImage(si, e.variantAttributes),
        genderCategory: si?.genderCategory || null,
        category: si?.category || null,
        moNumber: cr ? `MO-${cr.requestId}` : null,
        customerName: cr?.customerInfo?.name || null,
        requestType: cr?.requestType || null,
      };
    });

    const totalDispatched = enriched.reduce((s, e) => s + (e.dispatchedQuantity || 0), 0);

    res.json({
      success: true,
      events: enriched,
      total: enriched.length,
      totalUnitsDispatched: totalDispatched,
    });
  } catch (err) {
    console.error("[CEO Dispatch] /dispatched:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

module.exports = router;