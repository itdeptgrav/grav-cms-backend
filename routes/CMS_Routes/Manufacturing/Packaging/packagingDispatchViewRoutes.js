// routes/CMS_Routes/Manufacturing/Packaging/packagingDispatchViewRoutes.js
//
// Read-only + dispatch routes for the Packaging & Dispatch department.
// Mount at /api/cms/manufacturing/packaging-dispatch-view
//
// ── WHO, AND WHOSE WORK ─────────────────────────────────────────────────────
// Every route here is guarded by `packagingAccess`: reads by the Packaging
// viewer and the two departments whose own screens already show these numbers
// (Production planning and the executive office); dispatch by the Packaging
// EDITOR alone. Reading the floor is not being on it.
//
// Every query is narrowed to the acting company through
// `WorkOrder.salesLineLink.companyId` — the link the Sales-line ↔ WorkOrder
// bridge stamps at creation, and the only authoritative company fact there is.
// A Manufacturing Order is visible when at least one WorkOrder of this company
// is linked to it; its own status says nothing about whose it is. A historical
// WorkOrder with no link belongs to nobody: it is absent from every list and
// unaddressable by id, and is never given a company by its order, buyer, style,
// product, barcode text or the last characters of its id.
//
// A dispatch names progress documents and work orders by id. Every one of them
// is proved to be this company's BEFORE anything is written, and a batch that
// names one foreign, unlinked or unknown record is refused whole.

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const access = require("./packagingAccess");

router.use(EmployeeAuthMiddleware);

/* Reads: Packaging, plus the Production-planning and executive screens that
   already show these numbers. Writes: Packaging's editor, and nobody else. */
const canRead = [access.packagingReader(), access.packagingCompany];
const canRecord = [access.packagingDepartment("editor"), access.packagingCompany];

/** The acting company, resolved server-side. Never from the client. */
const companyOf = (req) => req.packaging.companyId;

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
router.get("/manufacturing-orders", ...canRead, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    /* ── WHICH ORDERS EXIST, FOR THIS COMPANY ──────────────────────────
       From the WORK, not from the order's status: an order is this
       company's when one of its WorkOrders is linked to this company. The
       status filter stays, because it is what makes an order a
       manufacturing order — it is simply not company proof. */
    const linked = await access.findWorkOrders(companyOf(req), {},
      "customerRequestId status quantity packagedQuantity dispatchedQuantity productionCompletion").lean();
    if (!linked.length) {
      return res.json({
        success: true,
        manufacturingOrders: [],
        pagination: { page: pageNum, limit: limitNum, total: 0, pages: 0 },
      });
    }
    const wosByMo = new Map();
    for (const wo of linked) {
      const key = String(wo.customerRequestId || "");
      if (!key) continue;
      if (!wosByMo.has(key)) wosByMo.set(key, []);
      wosByMo.get(key).push(wo);
    }

    const query = { _id: { $in: [...wosByMo.keys()].map(access.oid) }, status: "quotation_sales_approved" };
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
      /* This company's WorkOrders on that order, and only those: the totals
         below are this company's numbers, never the order's whole floor. */
      const wos = wosByMo.get(String(mo._id)) || [];

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
router.get("/manufacturing-orders/:id", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 12, search = "" } = req.query;

    /* An order with no WorkOrder of this company is not this company's, and
       answers exactly as one that does not exist — the id itself discloses
       nothing. */
    const { visible } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");

    const mo = await CustomerRequest.findById(id)
      .select("requestId customerInfo requestType measurementName priority createdAt deliveryDeadline")
      .lean();
    if (!mo) return access.notFound(res, "manufacturing order");

    const woFilter = access.scoped(companyOf(req), { customerRequestId: id });
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
router.get("/manufacturing-orders/:id/employees", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { search = "", page = 1, limit = 10 } = req.query;

    /* This company's WorkOrders on that order. No visible work, no order. */
    const { visible, objectIds } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");

    /* A person's progress belongs to a WorkOrder, so the WorkOrder is what
       proves whose it is — the order id alone never does. */
    const filter = {
      manufacturingOrderId: new mongoose.Types.ObjectId(id),
      workOrderId: { $in: objectIds },
    };
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
router.get("/manufacturing-orders/:id/bulk", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { search = "" } = req.query;

    const { visible } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");

    const filter = access.scoped(companyOf(req), {
      customerRequestId: new mongoose.Types.ObjectId(id),
    });
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

// ── GET /manufacturing-orders/:id/dispatch-history ───────────────────────────
// Query: page, limit, search, startDate (ISO), endDate (ISO)
router.get("/manufacturing-orders/:id/dispatch-history", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 25, search = "", startDate = "", endDate = "" } = req.query;

    const { visible, objectIds } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");

    const wos = await WorkOrder.find(access.scoped(companyOf(req), { customerRequestId: id }))
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes dispatchRecords")
      .lean();
    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));

    const events = [];

    // Bulk events
    for (const wo of wos) {
      const meta = wo.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      for (const rec of wo.dispatchRecords || []) {
        if (rec.dispatchType === "person_wise") continue;
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
            gender: meta?.genderCategory || meta?.gender || "",
            category: meta?.category || "",
            variantAttributes: wo.variantAttributes || [],
            quantity: rec.dispatchedQuantity,
          }],
          productCount: 1,
        });
      }
    }

    // Person-wise events (grouped by employee + minute bucket)
    const empDocs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      workOrderId: { $in: objectIds },
      "dispatchHistory.0": { $exists: true },
    })
      .select("employeeId employeeName employeeUIN workOrderId totalUnits packagedUnits dispatchHistory")
      .lean();

    const personEventMap = new Map();
    for (const ep of empDocs) {
      const wo = woMap.get(ep.workOrderId.toString());
      const meta = wo?.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      const product = {
        workOrderNumber: wo?.workOrderNumber || "—",
        productName: wo?.stockItemName || meta?.name || "—",
        productRef: wo?.stockItemReference || meta?.reference || "",
        gender: meta?.genderCategory || meta?.gender || "",
        category: meta?.category || "",
        variantAttributes: wo?.variantAttributes || [],
        quantity: ep.packagedUnits || ep.totalUnits || 0,
      };

      for (const h of ep.dispatchHistory || []) {
        const ts = new Date(h.dispatchedAt);
        const bucket = Math.floor(ts.getTime() / 60000);
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

    // ── Apply date filter ──────────────────────────────────────────────────
    let filtered = events;
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;
      if (end) end.setHours(23, 59, 59, 999); // include full end day

      filtered = filtered.filter((ev) => {
        const t = new Date(ev.dispatchedAt);
        if (start && t < start) return false;
        if (end && t > end) return false;
        return true;
      });
    }

    // Apply search
    if (search) {
      const term = search.trim().toLowerCase();
      filtered = filtered.filter((ev) => {
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
      allEvents: filtered, // for CSV export — frontend can use this when needed
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


// ── POST /manufacturing-orders/:id/lookup-by-barcodes ────────────────────────
// Body: { barcodes: ["WO-xxxx-001","WO-xxxx-002",...] }
// Resolves these barcodes → finds the employee in this MO who owns those units
// Returns the employee + dispatchable products (same shape as employees/:eid/products)
router.post("/manufacturing-orders/:id/lookup-by-barcodes", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { barcodes } = req.body;

    const { visible } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");
    if (!Array.isArray(barcodes) || !barcodes.length) {
      return res.status(400).json({ success: false, message: "barcodes array is required" });
    }

    // Parse each barcode → { woShortId, unit }
    const parsed = [];
    const invalid = [];
    for (const bc of barcodes) {
      if (typeof bc !== "string") { invalid.push(bc); continue; }
      const parts = bc.trim().split("-");
      if (parts.length >= 3 && parts[0] === "WO") {
        const unit = parseInt(parts[2], 10);
        if (!isNaN(unit) && unit > 0) {
          parsed.push({ barcode: bc.trim(), woShortId: parts[1], unit });
          continue;
        }
      }
      invalid.push(bc);
    }

    if (!parsed.length) {
      return res.status(400).json({
        success: false,
        message: "No valid barcodes",
        invalidBarcodes: invalid,
      });
    }

    /* ── A BARCODE NAMES WORK, NOT A COMPANY ──────────────────────────
       The short id in a barcode is the last 8 characters of a WorkOrder id,
       which is not unique and is not proof of anything. So the candidates
       are only THIS company's WorkOrders on THIS order, and a short id that
       two of them share is refused rather than resolved to whichever was
       read first — an ambiguous scan is a question for a human, and it can
       never cross a company boundary because nothing outside this company's
       work is in the map to begin with. */
    const allWOs = await WorkOrder.find(access.scoped(companyOf(req), { customerRequestId: id }))
      .select("_id workOrderNumber stockItemId stockItemName stockItemReference variantAttributes")
      .lean();
    const woByShortId = new Map();
    const ambiguousShortIds = new Set();
    for (const wo of allWOs) {
      const shortId = wo._id.toString().slice(-8);
      if (woByShortId.has(shortId)) ambiguousShortIds.add(shortId);
      woByShortId.set(shortId, wo);
    }
    for (const shortId of ambiguousShortIds) woByShortId.delete(shortId);

    // Match barcodes to WOs and collect (workOrderId, unitNumber) pairs
    const woUnits = new Map(); // workOrderId.toString() -> Set<unitNumber>
    const unmatchedBarcodes = [];
    for (const p of parsed) {
      const wo = woByShortId.get(p.woShortId);
      if (!wo) {
        unmatchedBarcodes.push(p.barcode);
        continue;
      }
      const key = wo._id.toString();
      if (!woUnits.has(key)) woUnits.set(key, new Set());
      woUnits.get(key).add(p.unit);
    }

    if (woUnits.size === 0) {
      return res.json({
        success: false,
        message: "No barcodes matched any WO in this MO",
        invalidBarcodes: [...invalid, ...unmatchedBarcodes],
      });
    }

    // Find EmployeeProductionProgress docs whose unit ranges contain these units
    const candidateDocs = await EmployeeProductionProgress.find({
      manufacturingOrderId: new mongoose.Types.ObjectId(id),
      workOrderId: { $in: [...woUnits.keys()].map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();

    // Score each employee — count how many scanned units fall in their range
    const empScore = new Map(); // employeeId -> { count, docs:[...] }
    for (const doc of candidateDocs) {
      const units = woUnits.get(doc.workOrderId.toString());
      if (!units) continue;
      let hits = 0;
      for (const u of units) {
        if (u >= doc.unitStart && u <= doc.unitEnd) hits++;
      }
      if (hits === 0) continue;
      const empKey = doc.employeeId?.toString();
      if (!empKey) continue;
      if (!empScore.has(empKey)) {
        empScore.set(empKey, { count: 0, docs: [], employeeName: doc.employeeName, employeeUIN: doc.employeeUIN, employeeId: doc.employeeId });
      }
      const rec = empScore.get(empKey);
      rec.count += hits;
      rec.docs.push(doc);
    }

    if (empScore.size === 0) {
      return res.json({
        success: false,
        message: "Barcodes don't match any employee's assigned unit range",
        invalidBarcodes: [...invalid, ...unmatchedBarcodes],
      });
    }

    // Pick the employee with the highest hit count
    const best = [...empScore.values()].sort((a, b) => b.count - a.count)[0];

    // Build product list (only dispatchable ones — same logic as /employees/:eid/products)
    const allEmpDocs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      employeeId: best.employeeId,
    }).lean();

    const woIds = [...new Set(allEmpDocs.map((d) => d.workOrderId.toString()))];
    const wos = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes")
      .lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));
    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));

    const products = allEmpDocs.map((doc) => {
      const wo = woMap.get(doc.workOrderId.toString());
      const meta = wo?.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;
      return {
        progressDocId: doc._id,
        workOrderId: doc.workOrderId,
        workOrderNumber: wo?.workOrderNumber || "—",
        productName: wo?.stockItemName || meta?.name || "—",
        productRef: wo?.stockItemReference || meta?.reference || "",
        productGender: meta?.genderCategory || meta?.gender || "",
        productCategory: meta?.category || "",
        variantAttributes: wo?.variantAttributes || [],
        totalUnits: doc.totalUnits,
        packagedUnits: doc.packagedUnits || 0,
        isFullyPackaged: doc.isFullyPackaged || false,
        isDispatched: doc.isDispatched || false,
        canDispatch: (doc.packagedUnits || 0) > 0 && !doc.isDispatched,
      };
    });

    products.sort((a, b) => a.productName.localeCompare(b.productName));

    return res.json({
      success: true,
      employee: {
        employeeId: best.employeeId,
        employeeName: best.employeeName,
        employeeUIN: best.employeeUIN,
      },
      products,
      barcodesScanned: parsed.length,
      barcodesMatched: best.count,
      invalidBarcodes: [...invalid, ...unmatchedBarcodes],
    });
  } catch (err) {
    console.error("PD lookup-by-barcodes error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


// ── GET /manufacturing-orders/:id/remaining-employees ────────────────────────
// Returns employees whose packaged units haven't been fully dispatched yet.
router.get("/manufacturing-orders/:id/remaining-employees", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { visible, objectIds } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");

    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: new mongoose.Types.ObjectId(id),
      workOrderId: { $in: objectIds },
      isDispatched: false,
      packagedUnits: { $gt: 0 },
    }).lean();

    if (!docs.length) {
      return res.json({ success: true, employees: [], totals: { employees: 0, products: 0, units: 0 } });
    }

    const woIds = [...new Set(docs.map((d) => d.workOrderId.toString()))];
    const wos = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes")
      .lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));
    const metaMap = await resolveStockItemMeta(wos.map((w) => w.stockItemId));

    // Group by employee
    const empMap = new Map();
    for (const doc of docs) {
      const key = doc.employeeId?.toString();
      if (!key) continue;
      const wo = woMap.get(doc.workOrderId.toString());
      const meta = wo?.stockItemId ? metaMap.get(wo.stockItemId.toString()) : null;

      if (!empMap.has(key)) {
        empMap.set(key, {
          employeeId: doc.employeeId,
          employeeName: doc.employeeName,
          employeeUIN: doc.employeeUIN,
          gender: doc.gender || "",
          products: [],
          totalProducts: 0,
          totalUnits: 0,
        });
      }
      const rec = empMap.get(key);
      rec.products.push({
        progressDocId: doc._id,
        workOrderId: doc.workOrderId,
        workOrderNumber: wo?.workOrderNumber || "—",
        productName: wo?.stockItemName || meta?.name || "—",
        productRef: wo?.stockItemReference || meta?.reference || "",
        productGender: meta?.genderCategory || meta?.gender || "",
        productCategory: meta?.category || "",
        variantAttributes: wo?.variantAttributes || [],
        packagedUnits: doc.packagedUnits || 0,
        totalUnits: doc.totalUnits || 0,
      });
      rec.totalProducts++;
      rec.totalUnits += doc.packagedUnits || 0;
    }

    const employees = [...empMap.values()].sort((a, b) =>
      a.employeeName.localeCompare(b.employeeName)
    );

    return res.json({
      success: true,
      employees,
      totals: {
        employees: employees.length,
        products: employees.reduce((s, e) => s + e.totalProducts, 0),
        units: employees.reduce((s, e) => s + e.totalUnits, 0),
      },
    });
  } catch (err) {
    console.error("PD remaining employees error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-orders/:id/employees/search
// Suggest employees by UIN/name for the New Dispatch interface
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:id/employees/search", ...canRead, async (req, res) => {
  try {
    const { id } = req.params;
    const { query = "" } = req.query;

    const { visible, objectIds } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");
    if (!query || query.trim().length < 2) {
      return res.json({ success: true, results: [] });
    }

    const re = new RegExp(query.trim(), "i");
    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      workOrderId: { $in: objectIds },
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
router.get("/manufacturing-orders/:id/employees/:employeeId/products", ...canRead, async (req, res) => {
  try {
    const { id, employeeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }
    const { visible, objectIds } = await access.moScope(companyOf(req), id);
    if (!visible) return access.notFound(res, "manufacturing order");

    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: id,
      workOrderId: { $in: objectIds },
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
router.post("/dispatch/person-wise", ...canRecord, async (req, res) => {
  try {
    const { items, notes = "" } = req.body;
    const dispatchedBy = req.user?.name || req.user?.employeeId || "Dispatch Dept";

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: "No items provided" });
    }

    /* ── PROVED WHOLE, BEFORE ANYTHING IS WRITTEN ──────────────────────
       Every progress document named here is resolved through the WorkOrder
       it belongs to, and that WorkOrder must be this company's. One id that
       is another company's, unlinked, unknown or malformed refuses the whole
       batch: a dispatch half-written across a company boundary is worse than
       one refused, and the caller is told nothing about what it named. */
    const proof = await access.resolveProgressDocs(companyOf(req), items.map((i) => i?.progressDocId));
    if (proof.unproven.length) return access.notFound(res, "dispatchable work");

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
      /* Proved above; this is the same document, read once. */
      const doc = proof.byId.get(String(item.progressDocId));

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
      /* Company-scoped, like every other WorkOrder read here: the id came
         from a document already proved to be this company's, and it is
         re-read under the scope rather than by id alone. */
      const wo = await WorkOrder.findOne(access.scoped(companyOf(req), { _id: agg.workOrderId }));
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
router.post("/dispatch/bulk", ...canRecord, async (req, res) => {
  try {
    const { workOrderId, quantity, notes = "" } = req.body;
    const dispatchedBy = req.user?.name || req.user?.employeeId || "Dispatch Dept";

    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      return res.status(400).json({ success: false, message: "Invalid quantity" });
    }

    /* Another company's, unlinked, unknown and malformed are one answer: the
       id names no work of yours. */
    if (!access.isId(workOrderId)) return access.notFound(res, "work order");
    const wo = await WorkOrder.findOne(access.scoped(companyOf(req), { _id: access.oid(workOrderId) }));
    if (!wo) return access.notFound(res, "work order");

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