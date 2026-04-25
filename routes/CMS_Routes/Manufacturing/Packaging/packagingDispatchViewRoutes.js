// routes/CMS_Routes/Manufacturing/Packaging/packagingDispatchViewRoutes.js
//
// Read-only + dispatch routes for the Packaging & Dispatch department.
// Mount at /api/cms/manufacturing/packaging-dispatch-view

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: resolve gender/category for a list of stockItemIds
// ─────────────────────────────────────────────────────────────────────────────
async function resolveStockItemMeta(stockItemIds) {
  const uniq = [...new Set(stockItemIds.filter(Boolean).map((id) => id.toString()))];
  if (!uniq.length) return new Map();
  const items = await StockItem.find({ _id: { $in: uniq } })
    .select("name reference gender category")
    .lean();
  return new Map(items.map((i) => [i._id.toString(), i]));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders", async (req, res) => {
  try {
    const { page = 1, limit = 12, search = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const query = { status: "quotation_sales_approved" };
    if (search) {
      const re = new RegExp(search.trim(), "i");
      query.$or = [
        { "customerInfo.name": re },
        { requestId: re },
        { measurementName: re },
      ];
    }

    const all = await CustomerRequest.find(query)
      .select("requestId customerInfo items createdAt requestType measurementName priority")
      .sort({ updatedAt: -1 })
      .lean();

    const enriched = [];
    for (const mo of all) {
      const wos = await WorkOrder.find({ customerRequestId: mo._id })
        .select("status quantity packagedQuantity dispatchedQuantity productionCompletion")
        .lean();

      if (!wos.length) continue;

      let derivedStatus = "pending";
      const statuses = wos.map((w) => w.status);
      if (statuses.every((s) => s === "completed")) derivedStatus = "completed";
      else if (statuses.some((s) => ["in_progress", "paused", "scheduled", "ready_to_start"].includes(s)))
        derivedStatus = "in_production";
      else if (statuses.every((s) => s === "pending")) derivedStatus = "pending";
      else if (statuses.some((s) => s === "planned")) derivedStatus = "planning";

      if (derivedStatus === "pending") continue;

      const totalQty       = wos.reduce((s, w) => s + (w.quantity || 0), 0);
      const packagedQty    = wos.reduce((s, w) => s + (w.packagedQuantity || 0), 0);
      const dispatchedQty  = wos.reduce((s, w) => s + (w.dispatchedQuantity || 0), 0);

      enriched.push({
        _id: mo._id,
        moNumber: `MO-${mo.requestId}`,
        requestId: mo.requestId,
        customerName: mo.customerInfo?.name || "—",
        requestType: mo.requestType || "customer_request",
        measurementName: mo.measurementName || null,
        priority: mo.priority || "medium",
        createdAt: mo.createdAt,
        derivedStatus,
        totalQuantity: totalQty,
        packagedQuantity: packagedQty,
        dispatchedQuantity: dispatchedQty,
        workOrdersCount: wos.length,
      });
    }

    const total = enriched.length;
    const paged = enriched.slice(skip, skip + limitNum);

    return res.json({
      success: true,
      manufacturingOrders: paged,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    console.error("PD MO list error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id
// Returns MO header + paginated WO list (with gender/category + sorted by product name)
// Query: page, limit, search
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 12, search = "" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }

    const mo = await CustomerRequest.findById(id)
      .select("requestId customerInfo requestType measurementName priority createdAt deliveryDeadline")
      .lean();
    if (!mo) return res.status(404).json({ success: false, message: "MO not found" });

    const woFilter = { customerRequestId: id };
    if (search) {
      const re = new RegExp(search.trim(), "i");
      woFilter.$or = [
        { stockItemName: re },
        { workOrderNumber: re },
        { stockItemReference: re },
      ];
    }

    const allWOs = await WorkOrder.find(woFilter)
      .select("workOrderNumber status quantity stockItemId stockItemName stockItemReference variantAttributes productionCompletion packagedQuantity dispatchedQuantity")
      .lean();

    // Resolve gender/category
    const metaMap = await resolveStockItemMeta(allWOs.map((w) => w.stockItemId));

    const transformedAll = allWOs.map((wo) => {
      const meta = wo.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      return {
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        status: wo.status,
        quantity: wo.quantity,
        stockItemName: wo.stockItemName || meta?.name || "—",
        stockItemReference: wo.stockItemReference || meta?.reference || "",
        gender: meta?.gender || "",
        category: meta?.category || "",
        variantAttributes: wo.variantAttributes || [],
        completedQuantity: wo.productionCompletion?.overallCompletedQuantity || 0,
        completionPercentage: wo.productionCompletion?.overallCompletionPercentage || 0,
        packagedQuantity: wo.packagedQuantity || 0,
        dispatchedQuantity: wo.dispatchedQuantity || 0,
      };
    });

    // Sort by product name alphabetically (groups related products together)
    transformedAll.sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));

    // Paginate
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const paged = transformedAll.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    const isMeasurement = mo.requestType === "measurement_conversion";

    return res.json({
      success: true,
      manufacturingOrder: {
        _id: mo._id,
        moNumber: `MO-${mo.requestId}`,
        requestId: mo.requestId,
        customerInfo: mo.customerInfo,
        customerName: mo.customerInfo?.name,
        requestType: mo.requestType,
        measurementName: mo.measurementName,
        priority: mo.priority,
        createdAt: mo.createdAt,
        deliveryDeadline: mo.deliveryDeadline || mo.customerInfo?.deliveryDeadline,
        isMeasurementConversion: isMeasurement,
        requestTypeBadge: isMeasurement ? "MEASUREMENT" : "CUSTOMER",
        workOrders: paged,
        totalWorkOrders: transformedAll.length,
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: transformedAll.length,
        totalPages: Math.ceil(transformedAll.length / limitNum),
      },
    });
  } catch (err) {
    console.error("PD MO detail error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id/employees  (unchanged from before)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id/employees", async (req, res) => {
  try {
    const { id } = req.params;
    const { search = "", page = 1, limit = 10 } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }

    const filter = { manufacturingOrderId: new mongoose.Types.ObjectId(id) };
    if (search) {
      const re = new RegExp(search.trim(), "i");
      filter.$or = [{ employeeName: re }, { employeeUIN: re }];
    }

    const docs = await EmployeeProductionProgress.find(filter)
      .sort({ employeeName: 1, workOrderId: 1 })
      .lean();

    if (!docs.length) {
      return res.json({
        success: true,
        employeeData: [],
        stats: { totalEmployees: 0, totalUnitsAssigned: 0, totalUnitsCompleted: 0, totalUnitsPackaged: 0, totalWorkOrders: 0 },
        pagination: { page: 1, limit: parseInt(limit, 10), total: 0, totalPages: 0 },
      });
    }

    const woIds = [...new Set(docs.map((d) => d.workOrderId.toString()))];
    const wos = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes")
      .lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));
    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));

    const empMap = new Map();
    for (const doc of docs) {
      const key = doc.employeeId?.toString();
      if (!key) continue;
      const wo = woMap.get(doc.workOrderId.toString());
      const meta = wo?.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      const variantName = wo?.variantAttributes?.length
        ? wo.variantAttributes.map((v) => v.value).join(" / ")
        : "Default";

      if (!empMap.has(key)) {
        empMap.set(key, {
          employeeId: doc.employeeId,
          employeeName: doc.employeeName,
          employeeUIN: doc.employeeUIN,
          gender: doc.gender || "",
          products: [],
          totalUnitsAssigned: 0,
          totalUnitsCompleted: 0,
          totalUnitsPackaged: 0,
        });
      }

      const rec = empMap.get(key);
      rec.products.push({
        progressDocId: doc._id,
        workOrderId: doc.workOrderId,
        workOrderNumber: wo?.workOrderNumber || "—",
        productName: wo?.stockItemName || meta?.name || "—",
        productRef: wo?.stockItemReference || meta?.reference || "",
        productGender: meta?.gender || "",
        productCategory: meta?.category || "",
        variantName,
        unitStart: doc.unitStart,
        unitEnd: doc.unitEnd,
        totalUnits: doc.totalUnits,
        completedUnits: doc.completedUnits || 0,
        packagedUnits: doc.packagedUnits || 0,
        isFullyPackaged: doc.isFullyPackaged || false,
        isDispatched: doc.isDispatched || false,
        dispatchedAt: doc.dispatchHistory?.length
          ? doc.dispatchHistory[doc.dispatchHistory.length - 1].dispatchedAt
          : null,
      });

      rec.totalUnitsAssigned  += doc.totalUnits || 0;
      rec.totalUnitsCompleted += doc.completedUnits || 0;
      rec.totalUnitsPackaged  += doc.packagedUnits || 0;
    }

    // Sort products within each employee by product name
    for (const emp of empMap.values()) {
      emp.products.sort((a, b) => a.productName.localeCompare(b.productName));
    }

    const employeeData = [...empMap.values()];
    const stats = {
      totalEmployees: employeeData.length,
      totalUnitsAssigned:  employeeData.reduce((s, e) => s + e.totalUnitsAssigned, 0),
      totalUnitsCompleted: employeeData.reduce((s, e) => s + e.totalUnitsCompleted, 0),
      totalUnitsPackaged:  employeeData.reduce((s, e) => s + e.totalUnitsPackaged, 0),
      totalWorkOrders: woIds.length,
    };

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const paged = employeeData.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return res.json({
      success: true,
      employeeData: paged,
      stats,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: employeeData.length,
        totalPages: Math.ceil(employeeData.length / limitNum),
      },
    });
  } catch (err) {
    console.error("PD employee tracking error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id/bulk
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id/bulk", async (req, res) => {
  try {
    const { id } = req.params;
    const { search = "" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }

    const filter = { customerRequestId: new mongoose.Types.ObjectId(id) };
    if (search) {
      const re = new RegExp(search.trim(), "i");
      filter.$or = [
        { stockItemName: re },
        { workOrderNumber: re },
        { stockItemReference: re },
      ];
    }

    const wos = await WorkOrder.find(filter)
      .select("workOrderNumber status quantity stockItemId stockItemName stockItemReference variantAttributes productionCompletion packagedQuantity dispatchedQuantity")
      .lean();

    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));

    const workOrders = wos.map((wo) => {
      const meta = wo.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      const completedQty  = wo.productionCompletion?.overallCompletedQuantity || 0;
      const packagedQty   = wo.packagedQuantity || 0;
      const dispatchedQty = wo.dispatchedQuantity || 0;
      return {
        workOrderId: wo._id,
        workOrderNumber: wo.workOrderNumber,
        status: wo.status,
        productName: wo.stockItemName || meta?.name || "—",
        productRef: wo.stockItemReference || meta?.reference || "",
        productGender: meta?.gender || "",
        productCategory: meta?.category || "",
        variantAttributes: wo.variantAttributes || [],
        totalQuantity: wo.quantity || 0,
        completedQuantity: completedQty,
        packagedQuantity: packagedQty,
        dispatchedQuantity: dispatchedQty,
        availableForDispatch: Math.max(0, packagedQty - dispatchedQty),
      };
    });

    workOrders.sort((a, b) => a.productName.localeCompare(b.productName));

    const totals = workOrders.reduce((acc, wo) => {
      acc.totalQty      += wo.totalQuantity;
      acc.completedQty  += wo.completedQuantity;
      acc.packagedQty   += wo.packagedQuantity;
      acc.dispatchedQty += wo.dispatchedQuantity;
      acc.availableQty  += wo.availableForDispatch;
      return acc;
    }, { totalQty: 0, completedQty: 0, packagedQty: 0, dispatchedQty: 0, availableQty: 0 });

    return res.json({ success: true, workOrders, totals });
  } catch (err) {
    console.error("PD bulk tracking error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DISPATCH SECTION
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id/dispatch-history
// Returns consolidated dispatch history for MO — both employee + bulk
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id/dispatch-history", async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 25, search = "" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }

    const wos = await WorkOrder.find({ customerRequestId: id })
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes dispatchRecords")
      .lean();
    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));

    const events = [];

    // ── BULK events ─────────────────────────────────────────────────────
    for (const wo of wos) {
      const meta = wo.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      for (const rec of wo.dispatchRecords || []) {
        if (rec.dispatchType === "person_wise") continue; // person-wise handled below via EmployeeProductionProgress
        events.push({
          _id: rec._id,
          type: "bulk",
          dispatchedAt: rec.dispatchedAt,
          dispatchedBy: rec.dispatchedBy,
          totalUnits: rec.dispatchedQuantity,
          notes: rec.notes || "",
          employeeName: null,
          employeeUIN: null,
          products: [{
            workOrderNumber: wo.workOrderNumber,
            productName: wo.stockItemName || meta?.name || "—",
            productRef: wo.stockItemReference || meta?.reference || "",
            gender: meta?.gender || "",
            category: meta?.category || "",
            variantAttributes: wo.variantAttributes || [],
            quantity: rec.dispatchedQuantity,
          }],
          productCount: 1,
        });
      }
    }

    // ── PERSON-WISE events — group by (employee + dispatch timestamp bucket) ─
    const empDocs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      "dispatchHistory.0": { $exists: true },
    })
      .select("employeeId employeeName employeeUIN workOrderId totalUnits packagedUnits dispatchHistory")
      .lean();

    // Group: key = employeeId + timestamp (truncated to minute for safety)
    const personEventMap = new Map();

    for (const ep of empDocs) {
      const wo = woMap.get(ep.workOrderId.toString());
      const meta = wo?.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      const product = {
        workOrderNumber: wo?.workOrderNumber || "—",
        productName: wo?.stockItemName || meta?.name || "—",
        productRef: wo?.stockItemReference || meta?.reference || "",
        gender: meta?.gender || "",
        category: meta?.category || "",
        variantAttributes: wo?.variantAttributes || [],
        quantity: ep.packagedUnits || ep.totalUnits || 0,
      };

      for (const h of ep.dispatchHistory || []) {
        // Bucket by minute so a single "Dispatch Queue" action groups its products
        const ts = new Date(h.dispatchedAt);
        const bucket = Math.floor(ts.getTime() / 60000); // minute precision
        const key = `${ep.employeeId}_${bucket}_${h.dispatchedBy || ""}`;

        if (!personEventMap.has(key)) {
          personEventMap.set(key, {
            _id: h._id,
            type: "person_wise",
            dispatchedAt: h.dispatchedAt,
            dispatchedBy: h.dispatchedBy,
            notes: h.notes || "",
            employeeId: ep.employeeId,
            employeeName: ep.employeeName,
            employeeUIN: ep.employeeUIN,
            totalUnits: 0,
            products: [],
            productCount: 0,
          });
        }

        const ev = personEventMap.get(key);
        ev.products.push(product);
        ev.totalUnits += product.quantity;
        ev.productCount++;
      }
    }

    for (const ev of personEventMap.values()) {
      ev.products.sort((a, b) => a.productName.localeCompare(b.productName));
      events.push(ev);
    }

    // ── Apply search ────────────────────────────────────────────────────
    let filtered = events;
    if (search) {
      const term = search.trim().toLowerCase();
      filtered = events.filter((ev) => {
        if (ev.employeeName?.toLowerCase().includes(term)) return true;
        if (ev.employeeUIN?.toLowerCase().includes(term)) return true;
        if (ev.dispatchedBy?.toLowerCase().includes(term)) return true;
        return ev.products.some(
          (p) =>
            p.productName.toLowerCase().includes(term) ||
            p.workOrderNumber?.toLowerCase().includes(term)
        );
      });
    }

    // Sort newest first
    filtered.sort((a, b) => new Date(b.dispatchedAt) - new Date(a.dispatchedAt));

    const totals = filtered.reduce(
      (acc, e) => {
        acc.totalEvents++;
        acc.totalUnits += e.totalUnits;
        if (e.type === "person_wise") acc.personWiseCount++;
        else acc.bulkCount++;
        return acc;
      },
      { totalEvents: 0, totalUnits: 0, personWiseCount: 0, bulkCount: 0 }
    );

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const paged = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return res.json({
      success: true,
      events: paged,
      totals,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / limitNum),
      },
    });
  } catch (err) {
    console.error("PD dispatch history error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id/employees/search
// Suggest employees by UIN/name for the New Dispatch interface
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id/employees/search", async (req, res) => {
  try {
    const { id } = req.params;
    const { query = "" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }
    if (!query || query.trim().length < 2) {
      return res.json({ success: true, results: [] });
    }

    const re = new RegExp(query.trim(), "i");
    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      $or: [{ employeeName: re }, { employeeUIN: re }],
    }).lean();

    // Group by employee
    const empMap = new Map();
    for (const doc of docs) {
      const key = doc.employeeId?.toString();
      if (!key) continue;
      if (!empMap.has(key)) {
        empMap.set(key, {
          employeeId: doc.employeeId,
          employeeName: doc.employeeName,
          employeeUIN: doc.employeeUIN,
          productCount: 0,
          hasDispatchableUnits: false,
        });
      }
      const rec = empMap.get(key);
      rec.productCount++;
      const availableToDispatch = (doc.packagedUnits || 0) - 0; // doc doesn't track dispatched units separately
      // Consider dispatchable if packaged > 0 and not already fully dispatched
      if ((doc.packagedUnits || 0) > 0 && !doc.isDispatched) {
        rec.hasDispatchableUnits = true;
      }
    }

    return res.json({ success: true, results: [...empMap.values()] });
  } catch (err) {
    console.error("PD employee search error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id/employees/:employeeId/products
// Fetch a specific employee's assigned products with dispatch availability
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id/employees/:employeeId/products", async (req, res) => {
  try {
    const { id, employeeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      employeeId,
    }).lean();

    if (!docs.length) return res.json({ success: true, employee: null, products: [] });

    const woIds = [...new Set(docs.map((d) => d.workOrderId.toString()))];
    const wos = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes")
      .lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));
    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));

    const products = docs.map((doc) => {
      const wo = woMap.get(doc.workOrderId.toString());
      const meta = wo?.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      return {
        progressDocId: doc._id,
        workOrderId: doc.workOrderId,
        workOrderNumber: wo?.workOrderNumber || "—",
        productName: wo?.stockItemName || meta?.name || "—",
        productRef: wo?.stockItemReference || meta?.reference || "",
        productGender: meta?.gender || "",
        productCategory: meta?.category || "",
        variantAttributes: wo?.variantAttributes || [],
        totalUnits: doc.totalUnits,
        packagedUnits: doc.packagedUnits || 0,
        isFullyPackaged: doc.isFullyPackaged || false,
        isDispatched: doc.isDispatched || false,
        dispatchHistory: doc.dispatchHistory || [],
        canDispatch: (doc.packagedUnits || 0) > 0 && !doc.isDispatched,
      };
    });

    products.sort((a, b) => a.productName.localeCompare(b.productName));

    return res.json({
      success: true,
      employee: {
        employeeId,
        employeeName: docs[0].employeeName,
        employeeUIN: docs[0].employeeUIN,
      },
      products,
    });
  } catch (err) {
    console.error("PD employee products error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /dispatch/person-wise
// Dispatch person-wise items.
// Body: { items: [{ progressDocId, quantity?(optional, defaults to packagedUnits) }], notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/dispatch/person-wise", async (req, res) => {
  try {
    const { items, notes = "" } = req.body;
    const dispatchedBy = req.user?.name || req.user?.employeeId || "Dispatch Dept";

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: "No items provided" });
    }

    const now = new Date();
    const summary = {
      itemsDispatched: 0,
      unitsDispatched: 0,
      workOrdersTouched: new Set(),
      failed: [],
    };

    // Group items by WO so WO.dispatchRecords gets one entry per WO per batch
    const byWO = new Map();

    for (const item of items) {
      if (!mongoose.Types.ObjectId.isValid(item.progressDocId)) {
        summary.failed.push({ progressDocId: item.progressDocId, reason: "Invalid ID" });
        continue;
      }

      const doc = await EmployeeProductionProgress.findById(item.progressDocId);
      if (!doc) {
        summary.failed.push({ progressDocId: item.progressDocId, reason: "Not found" });
        continue;
      }

      if (doc.isDispatched) {
        summary.failed.push({
          progressDocId: item.progressDocId,
          employeeName: doc.employeeName,
          reason: "Already dispatched",
        });
        continue;
      }

      const packaged = doc.packagedUnits || 0;
      if (packaged <= 0) {
        summary.failed.push({
          progressDocId: item.progressDocId,
          employeeName: doc.employeeName,
          reason: "Nothing packaged yet",
        });
        continue;
      }

      // Mark as dispatched
      doc.isDispatched = true;
      doc.dispatchNotes = notes || doc.dispatchNotes || null;
      doc.dispatchHistory = doc.dispatchHistory || [];
      doc.dispatchHistory.push({
        dispatchedAt: now,
        dispatchedBy,
        notes,
      });
      await doc.save();

      summary.itemsDispatched++;
      summary.unitsDispatched += packaged;
      summary.workOrdersTouched.add(doc.workOrderId.toString());

      // Aggregate per WO for dispatchRecords
      const woKey = doc.workOrderId.toString();
      if (!byWO.has(woKey)) {
        byWO.set(woKey, {
          workOrderId: doc.workOrderId,
          totalQty: 0,
          employeeIds: [],
          employeeNames: [],
        });
      }
      const agg = byWO.get(woKey);
      agg.totalQty += packaged;
      if (doc.employeeId) agg.employeeIds.push(doc.employeeId);
      if (doc.employeeName) agg.employeeNames.push(doc.employeeName);
    }

    // Write WO.dispatchRecords + bump dispatchedQuantity
    for (const [woKey, agg] of byWO) {
      const wo = await WorkOrder.findById(agg.workOrderId);
      if (!wo) continue;

      const currentDispatched = wo.dispatchedQuantity || 0;
      const capped = Math.min((wo.quantity || 0), currentDispatched + agg.totalQty);
      wo.dispatchedQuantity = capped;

      wo.dispatchRecords = wo.dispatchRecords || [];
      wo.dispatchRecords.push({
        dispatchedQuantity: agg.totalQty,
        dispatchedAt: now,
        dispatchedBy,
        notes,
        dispatchType: "person_wise",
        employeeIds: agg.employeeIds,
        employeeNames: agg.employeeNames,
      });
      await wo.save();
    }

    return res.json({
      success: true,
      message: `Dispatched ${summary.itemsDispatched} item(s) · ${summary.unitsDispatched} units`,
      summary: {
        itemsDispatched: summary.itemsDispatched,
        unitsDispatched: summary.unitsDispatched,
        workOrdersTouched: summary.workOrdersTouched.size,
        failed: summary.failed,
      },
    });
  } catch (err) {
    console.error("PD person-wise dispatch error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /dispatch/bulk
// Dispatch a bulk WO's packaged units.
// Body: { workOrderId, quantity, notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/dispatch/bulk", async (req, res) => {
  try {
    const { workOrderId, quantity, notes = "" } = req.body;
    const dispatchedBy = req.user?.name || req.user?.employeeId || "Dispatch Dept";

    if (!mongoose.Types.ObjectId.isValid(workOrderId)) {
      return res.status(400).json({ success: false, message: "Invalid WO id" });
    }
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      return res.status(400).json({ success: false, message: "Invalid quantity" });
    }

    const wo = await WorkOrder.findById(workOrderId);
    if (!wo) return res.status(404).json({ success: false, message: "WO not found" });

    const packaged = wo.packagedQuantity || 0;
    const alreadyDispatched = wo.dispatchedQuantity || 0;
    const available = Math.max(0, packaged - alreadyDispatched);

    if (qty > available) {
      return res.status(400).json({
        success: false,
        message: `Only ${available} unit(s) available for dispatch`,
      });
    }

    const now = new Date();
    wo.dispatchedQuantity = alreadyDispatched + qty;
    wo.dispatchRecords = wo.dispatchRecords || [];
    wo.dispatchRecords.push({
      dispatchedQuantity: qty,
      dispatchedAt: now,
      dispatchedBy,
      notes,
      dispatchType: "bulk",
    });
    await wo.save();

    return res.json({
      success: true,
      message: `Dispatched ${qty} unit(s)`,
      workOrder: {
        workOrderId: wo._id,
        workOrderNumber: wo.workOrderNumber,
        dispatchedQuantity: wo.dispatchedQuantity,
        totalQuantity: wo.quantity,
      },
    });
  } catch (err) {
    console.error("PD bulk dispatch error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;