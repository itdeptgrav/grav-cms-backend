// routes/Customer_Routes/OrderTracking.js
//
// Customer-facing order tracking endpoints.
//
// FIXES IN THIS REVISION:
//  1. Product images now resolved with variant-first fallback (matching the
//     pattern used by cross-org-assign.js and other modules).
//  2. Employee tracking now $lookups WorkOrder to populate productName/Ref
//     in the per-employee expanded product list (previously the source field
//     didn't exist on EmployeeProductionProgress, so frontend showed "—").
//
// Quantity math (unchanged from previous fix):
//   pending      = total - started   (never touched)
//   inProduction = started - completed
//   completed    = passed all ops
//   pending + inProduction + completed === total

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");

// ─── Auth ────────────────────────────────────────────────────────────────────
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Access denied. Please sign in." });
    }
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key_2024",
    );
    req.customerId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid token. Please sign in again.",
    });
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const variantLabel = (attrs) =>
  Array.isArray(attrs) && attrs.length
    ? attrs
        .map((a) => a.value)
        .filter(Boolean)
        .join(" / ")
    : "Default";

// Resolve a usable image URL from a populated StockItem. Tries variants first
// (those usually have the actual product photos), then falls back to the
// product-level images array. Returns null if nothing usable exists.
const resolveProductImage = (stockItem, variantAttrs) => {
  if (!stockItem) return null;

  // 1) Try to match the WO's specific variant
  if (
    Array.isArray(variantAttrs) &&
    variantAttrs.length &&
    Array.isArray(stockItem.variants)
  ) {
    const norm = (s) =>
      String(s || "")
        .trim()
        .toLowerCase();
    const matchedVariant = stockItem.variants.find((v) => {
      const va = v.attributes || [];
      if (va.length !== variantAttrs.length) return false;
      return variantAttrs.every((ra) =>
        va.some(
          (x) =>
            norm(x.name) === norm(ra.name) && norm(x.value) === norm(ra.value),
        ),
      );
    });
    if (matchedVariant?.images?.[0]) return matchedVariant.images[0];
  }

  // 2) Try any variant that has an image
  for (const v of stockItem.variants || []) {
    if (v?.images?.[0]) return v.images[0];
  }

  // 3) Fall back to product-level image
  return stockItem.images?.[0] || null;
};

// Decide the lifecycle stage from quantity buckets
const deriveStage = ({
  total,
  inProduction = 0,
  completed,
  packaged,
  dispatched,
}) => {
  if (total <= 0) return "not_started";
  if (dispatched >= total) return "dispatched";
  if (dispatched > 0) return "dispatching";
  if (packaged >= total) return "packaged";
  if (packaged > 0) return "packaging";
  if (completed >= total) return "ready_to_pack";
  if (completed > 0) return "in_production";
  if (inProduction > 0) return "in_production";
  return "not_started";
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/customer/requests/:id/tracking
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:id/tracking", verifyCustomerToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request ID" });
    }

    const cr = await CustomerRequest.findOne({
      _id: id,
      customerId: req.customerId,
    })
      .select(
        "requestId customerInfo requestType measurementName status priority " +
          "estimatedCompletion deliveryDeadline createdAt finalOrderPrice",
      )
      .lean();

    if (!cr)
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });

    // ── Pull WOs + STOCK ITEM with variant images (so we can resolve photos)
    const workOrders = await WorkOrder.find({ customerRequestId: cr._id })
      .select(
        "workOrderNumber stockItemId stockItemName stockItemReference " +
          "quantity variantAttributes status " +
          "productionCompletion packagedQuantity dispatchedQuantity " +
          "dispatchRecords timeline createdAt",
      )
      .populate({
        path: "stockItemId",
        select: "name reference images variants.images variants.attributes",
      })
      .sort({ createdAt: 1 })
      .lean();

    const products = workOrders.map((wo) => {
      const pc = wo.productionCompletion || {};
      const total = wo.quantity || 0;
      const completed = pc.overallCompletedQuantity || 0;
      const packaged = wo.packagedQuantity || 0;
      const dispatched = wo.dispatchedQuantity || 0;

      const opCompletion = Array.isArray(pc.operationCompletion)
        ? pc.operationCompletion
        : [];
      const startedFromOps =
        opCompletion.length > 0
          ? Math.max(0, ...opCompletion.map((op) => op.completedQuantity || 0))
          : 0;
      const started = Math.max(startedFromOps, completed);

      const pending = Math.max(0, total - started);
      const inProduction = Math.max(0, started - completed);
      const readyToShip = Math.max(0, packaged - dispatched);

      const stage = deriveStage({
        total,
        inProduction,
        completed,
        packaged,
        dispatched,
      });
      const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);

      // Resolve product image (variant → any variant → product-level)
      const productImage = resolveProductImage(
        wo.stockItemId,
        wo.variantAttributes,
      );

      return {
        workOrderId: wo._id,
        workOrderNumber: wo.workOrderNumber,
        productName: wo.stockItemName || wo.stockItemId?.name || "—",
        productRef: wo.stockItemReference || wo.stockItemId?.reference || "",
        productImage,
        variantLabel: variantLabel(wo.variantAttributes),
        variantAttributes: wo.variantAttributes || [],

        quantities: {
          total,
          pending,
          inProduction,
          completed,
          packaged,
          dispatched,
          readyToShip,
        },
        percentages: {
          completed: pct(completed),
          packaged: pct(packaged),
          dispatched: pct(dispatched),
        },
        stage,
        status: wo.status,
        startedAt: wo.timeline?.actualStartDate || null,
        plannedEnd: wo.timeline?.plannedEndDate || null,
        lastSyncedAt: pc.lastSyncedAt || null,
      };
    });

    const totals = products.reduce(
      (acc, p) => {
        acc.total += p.quantities.total;
        acc.pending += p.quantities.pending;
        acc.inProduction += p.quantities.inProduction;
        acc.completed += p.quantities.completed;
        acc.packaged += p.quantities.packaged;
        acc.dispatched += p.quantities.dispatched;
        acc.readyToShip += p.quantities.readyToShip;
        return acc;
      },
      {
        total: 0,
        pending: 0,
        inProduction: 0,
        completed: 0,
        packaged: 0,
        dispatched: 0,
        readyToShip: 0,
      },
    );
    const overallPct =
      totals.total > 0
        ? Math.round((totals.dispatched / totals.total) * 100)
        : 0;

    const dispatchEvents = [];
    for (const wo of workOrders) {
      for (const rec of wo.dispatchRecords || []) {
        dispatchEvents.push({
          _id: rec._id,
          workOrderNumber: wo.workOrderNumber,
          productName: wo.stockItemName || "—",
          variantLabel: variantLabel(wo.variantAttributes),
          dispatchType: rec.dispatchType || "bulk",
          dispatchedQuantity: rec.dispatchedQuantity || 0,
          dispatchedAt: rec.dispatchedAt,
          dispatchedBy: rec.dispatchedBy || "—",
          notes: rec.notes || "",
          employeeNames: rec.employeeNames || [],
          employeeCount: (rec.employeeIds || []).length,
        });
      }
    }
    dispatchEvents.sort(
      (a, b) => new Date(b.dispatchedAt) - new Date(a.dispatchedAt),
    );

    let personWise = null;
    const isPersonWise = cr.requestType === "measurement_conversion";
    if (isPersonWise) {
      const agg = await EmployeeProductionProgress.aggregate([
        {
          $match: { manufacturingOrderId: new mongoose.Types.ObjectId(cr._id) },
        },
        {
          $group: {
            _id: "$employeeId",
            totalUnits: { $sum: "$totalUnits" },
            completedUnits: { $sum: "$completedUnits" },
            packagedUnits: { $sum: "$packagedUnits" },
            anyDispatched: { $max: { $cond: ["$isDispatched", 1, 0] } },
          },
        },
      ]);

      const counts = agg.reduce(
        (acc, e) => {
          acc.totalEmployees += 1;
          if (e.completedUnits >= e.totalUnits && e.totalUnits > 0)
            acc.fullyCompleted += 1;
          else if (e.completedUnits > 0) acc.inProgress += 1;
          else acc.notStarted += 1;
          if (e.packagedUnits >= e.totalUnits && e.totalUnits > 0)
            acc.fullyPackaged += 1;
          if (e.anyDispatched) acc.dispatched += 1;
          return acc;
        },
        {
          totalEmployees: 0,
          notStarted: 0,
          inProgress: 0,
          fullyCompleted: 0,
          fullyPackaged: 0,
          dispatched: 0,
        },
      );

      personWise = counts;
    }

    res.json({
      success: true,
      order: {
        _id: cr._id,
        requestId: cr.requestId,
        moNumber: `MO-${cr.requestId}`,
        requestType: cr.requestType || "customer_request",
        isPersonWise,
        measurementName: cr.measurementName || null,
        status: cr.status,
        priority: cr.priority,
        createdAt: cr.createdAt,
        estimatedCompletion: cr.estimatedCompletion,
        deliveryDeadline: cr.deliveryDeadline,
        finalOrderPrice: cr.finalOrderPrice || 0,
        customer: {
          name: cr.customerInfo?.name || "",
          city: cr.customerInfo?.city || "",
        },
      },
      summary: {
        ...totals,
        overallPct,
        totalProducts: products.length,
        totalDispatchEvents: dispatchEvents.length,
      },
      products,
      dispatchEvents,
      personWise,
    });
  } catch (err) {
    console.error("[customer/tracking] error:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error while loading tracking" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/customer/requests/:id/tracking/employees
// FIX: $lookup WorkOrder to attach stockItemName onto each progress doc
// BEFORE grouping, so each pushed product carries its real product name.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:id/tracking/employees", verifyCustomerToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request ID" });
    }

    const cr = await CustomerRequest.findOne({
      _id: id,
      customerId: req.customerId,
    })
      .select("_id requestType")
      .lean();
    if (!cr)
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      200,
      Math.max(1, parseInt(req.query.limit, 10) || 50),
    );
    const skip = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const stage = String(req.query.stage || "all").trim();
    const sort = String(req.query.sort || "name-asc").trim();

    const pipeline = [
      { $match: { manufacturingOrderId: new mongoose.Types.ObjectId(cr._id) } },
    ];

    if (search) {
      const regex = new RegExp(
        search.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
        "i",
      );
      pipeline.push({
        $match: { $or: [{ employeeName: regex }, { employeeUIN: regex }] },
      });
    }

    // ── NEW: Join WorkOrder to pull stockItemName / Reference ────────────
    // EmployeeProductionProgress doesn't store product name, so without this
    // every pushed product in the expanded row came back as null.
    pipeline.push({
      $lookup: {
        from: WorkOrder.collection.name, // safe: derived from model, not hardcoded
        localField: "workOrderId",
        foreignField: "_id",
        as: "_wo",
        pipeline: [{ $project: { stockItemName: 1, stockItemReference: 1 } }],
      },
    });

    pipeline.push({
      $addFields: {
        // Prefer existing snapshot field if your schema has it; fall back to WO
        productNameResolved: {
          $ifNull: [
            "$productName",
            { $arrayElemAt: ["$_wo.stockItemName", 0] },
          ],
        },
        productRefResolved: { $arrayElemAt: ["$_wo.stockItemReference", 0] },
      },
    });

    pipeline.push({
      $group: {
        _id: "$employeeId",
        employeeName: { $first: "$employeeName" },
        employeeUIN: { $first: "$employeeUIN" },
        gender: { $first: "$gender" },
        totalUnits: { $sum: "$totalUnits" },
        completedUnits: { $sum: "$completedUnits" },
        packagedUnits: { $sum: "$packagedUnits" },
        productCount: { $sum: 1 },
        dispatchedDocs: { $sum: { $cond: ["$isDispatched", 1, 0] } },
        lastSyncedAt: { $max: "$lastSyncedAt" },
        products: {
          $push: {
            productName: "$productNameResolved",
            productRef: "$productRefResolved",
            totalUnits: "$totalUnits",
            completedUnits: "$completedUnits",
            packagedUnits: "$packagedUnits",
            isDispatched: "$isDispatched",
            workOrderId: "$workOrderId",
          },
        },
      },
    });

    pipeline.push({
      $addFields: {
        completionPct: {
          $cond: [
            { $gt: ["$totalUnits", 0] },
            {
              $multiply: [{ $divide: ["$completedUnits", "$totalUnits"] }, 100],
            },
            0,
          ],
        },
        packagedPct: {
          $cond: [
            { $gt: ["$totalUnits", 0] },
            {
              $multiply: [{ $divide: ["$packagedUnits", "$totalUnits"] }, 100],
            },
            0,
          ],
        },
        allDispatched: { $eq: ["$dispatchedDocs", "$productCount"] },
      },
    });

    pipeline.push({
      $addFields: {
        stage: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [{ $gt: ["$dispatchedDocs", 0] }, "$allDispatched"],
                },
                then: "dispatched",
              },
              { case: { $gt: ["$dispatchedDocs", 0] }, then: "dispatching" },
              {
                case: { $gte: ["$packagedUnits", "$totalUnits"] },
                then: "packaged",
              },
              { case: { $gt: ["$packagedUnits", 0] }, then: "packaging" },
              {
                case: { $gte: ["$completedUnits", "$totalUnits"] },
                then: "ready_to_pack",
              },
              { case: { $gt: ["$completedUnits", 0] }, then: "in_production" },
            ],
            default: "not_started",
          },
        },
      },
    });

    if (stage && stage !== "all") {
      pipeline.push({ $match: { stage } });
    }

    const sortMap = {
      "name-asc": { employeeName: 1 },
      "name-desc": { employeeName: -1 },
      "uin-asc": { employeeUIN: 1 },
      "uin-desc": { employeeUIN: -1 },
      "progress-asc": { completionPct: 1 },
      "progress-desc": { completionPct: -1 },
      "stage-asc": { stage: 1, employeeName: 1 },
      "stage-desc": { stage: -1, employeeName: 1 },
    };
    pipeline.push({ $sort: sortMap[sort] || sortMap["name-asc"] });

    pipeline.push({
      $facet: {
        rows: [{ $skip: skip }, { $limit: limit }],
        meta: [{ $count: "total" }],
      },
    });

    const [agg = { rows: [], meta: [] }] =
      await EmployeeProductionProgress.aggregate(pipeline);
    const total = agg.meta?.[0]?.total || 0;

    const employees = (agg.rows || []).map((e) => ({
      employeeId: e._id,
      employeeName: e.employeeName || "—",
      employeeUIN: e.employeeUIN || "—",
      gender: e.gender || "",
      productCount: e.productCount || 0,
      products: (e.products || []).slice(0, 5).map((p) => ({
        productName: p.productName || "—",
        productRef: p.productRef || "",
        totalUnits: p.totalUnits || 0,
        completedUnits: p.completedUnits || 0,
        packagedUnits: p.packagedUnits || 0,
        isDispatched: !!p.isDispatched,
      })),
      totalUnits: e.totalUnits || 0,
      completedUnits: e.completedUnits || 0,
      packagedUnits: e.packagedUnits || 0,
      completionPct: Math.round(e.completionPct || 0),
      packagedPct: Math.round(e.packagedPct || 0),
      stage: e.stage || "not_started",
      lastSyncedAt: e.lastSyncedAt || null,
    }));

    res.json({
      success: true,
      employees,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: { search, stage, sort },
    });
  } catch (err) {
    console.error("[customer/tracking/employees] error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while loading employees",
    });
  }
});

module.exports = router;
