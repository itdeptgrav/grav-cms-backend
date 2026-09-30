// routes/Customer_Routes/OrderTracking.js
// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER-FACING tracking endpoints.
//
//   GET /:id/tracking
//     Returns per-product progress (quantities, percentages, stage) +
//     dispatch event list + person-wise summary counters.
//     Also, live from the scanners and QC: each product's production
//     stages with the pieces that have cleared each one, and its pieces
//     counted once each as not started / in process / completed /
//     rejected, with the same totals for the order (summary.pieces).
//
//   GET /:id/tracking/employees
//     Paginated employee progress for measurement (person-wise) orders.
//     Returns dispatchedUnits per employee + optionally all products
//     (?full=true) for use in the customer-side return drawer.
//
// FIX in this version:
//   - Dispatched quantity is computed as MAX(wo.dispatchedQuantity,
//     sum(wo.dispatchRecords[].dispatchedQuantity)).
//     The dispatch routes update both the direct field AND push a record;
//     reading both and taking the max removes any sync gap from edge cases
//     (legacy data, partial writes, missed migrations).
//   - Employees endpoint now returns dispatchedUnits (sum of totalUnits
//     for products where isDispatched is true) instead of only a count.
//   - ?full=true returns every product per employee instead of slicing to 5,
//     so the return drawer can show the complete picker list.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const ProductionTracking = require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const QCInspection = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const qcStages = require("../../services/qcStages");
const productionSync = require("../../services/productionSyncService");

// ─── Customer auth ──────────────────────────────────────────────────────────
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

// ─── Helpers ────────────────────────────────────────────────────────────────

// Build a "Color: Red · Size: M" style label from variantAttributes
const variantLabel = (attrs) => {
  if (!Array.isArray(attrs) || attrs.length === 0) return "—";
  return attrs
    .filter((a) => a && a.name && a.value)
    .map((a) => `${a.name}: ${a.value}`)
    .join(" · ");
};

// Resolve product image: matching variant → any variant with image → product
const resolveProductImage = (stockItem, variantAttrs) => {
  if (!stockItem) return null;
  if (Array.isArray(variantAttrs) && variantAttrs.length > 0) {
    const matchedVariant = (stockItem.variants || []).find((v) =>
      (v.attributes || []).every((va) =>
        variantAttrs.some(
          (woa) => woa.name === va.name && woa.value === va.value,
        ),
      ),
    );
    if (matchedVariant?.images?.[0]) return matchedVariant.images[0];
  }
  for (const v of stockItem.variants || []) {
    if (v?.images?.[0]) return v.images[0];
  }
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

// ★ DISPATCH SYNC FIX ★
// The dispatch routes update wo.dispatchedQuantity AND push to
// wo.dispatchRecords. In edge cases (legacy data, partial writes, schema
// migrations) the direct field can be out of sync. Take MAX of both sources
// so the customer never sees a stale 0.
const computeDispatched = (wo) => {
  const directField = Number(wo.dispatchedQuantity || 0);
  const fromRecords = (wo.dispatchRecords || []).reduce(
    (sum, rec) => sum + (Number(rec.dispatchedQuantity) || 0),
    0,
  );
  return Math.max(directField, fromRecords);
};

// ─── Live piece progress: the scanners and QC ───────────────────────────────
// Every garment carries a barcode, WO-<last 8 of the work order id>-<unit>.
// The machines scan it at each production stage (ProductionTracking, written
// as it happens) and the production sync rolls those scans up onto the work
// order (productionCompletion.operationCompletion[].completedUnitNumbers).
// QC scans it at its checkpoints (QCInspection, written as it happens).
// Adding the scans made since the last sync to the rollup makes the counts
// live. Nothing here writes.

const shortIdOf = (id) => String(id).slice(-8);

// The piece's unit number, or null when the barcode is not one of this work
// order's pieces. Same parsing as the production sync.
const unitOf = (barcodeId, quantity) => {
  const unit = parseInt(String(barcodeId || "").split("-")[2], 10);
  return Number.isInteger(unit) && unit >= 1 && unit <= quantity ? unit : null;
};

const latestOf = (...dates) =>
  dates
    .filter(Boolean)
    .map((d) => new Date(d))
    .reduce((a, b) => (!a || b > a ? b : a), null);

// Machine scans of this order's pieces that the rollup may not have counted:
// everything since the oldest last sync among its work orders (or since the
// work order was created, if it was never synced). Scans are stored one
// document per day, so the read starts a day and a half early to be safe
// about time zones; reading a scan the rollup already has changes nothing,
// because pieces are counted by unit number. The database does the
// filtering, so only this order's scans come back.
async function recentScans(workOrders) {
  const byShortId = new Map(workOrders.map((wo) => [shortIdOf(wo._id), []]));
  if (!workOrders.length) return byShortId;

  const DAY_AND_A_HALF = 36 * 60 * 60 * 1000;
  const since = new Date(
    Math.min(
      ...workOrders.map((wo) =>
        new Date(wo.productionCompletion?.lastSyncedAt || wo.createdAt || 0).getTime(),
      ),
    ) - DAY_AND_A_HALF,
  );
  const barcode = { $regex: `^WO-(${[...byShortId.keys()].join("|")})-` };

  const scans = await ProductionTracking.aggregate([
    { $match: { date: { $gte: since }, "machines.operators.barcodeScans.barcodeId": barcode } },
    { $unwind: "$machines" },
    { $unwind: "$machines.operators" },
    { $unwind: "$machines.operators.barcodeScans" },
    { $match: { "machines.operators.barcodeScans.barcodeId": barcode } },
    {
      $project: {
        _id: 0,
        barcodeId: "$machines.operators.barcodeScans.barcodeId",
        timeStamp: "$machines.operators.barcodeScans.timeStamp",
        activeOps: "$machines.operators.barcodeScans.activeOps",
      },
    },
  ]);

  for (const scan of scans) {
    byShortId.get(String(scan.barcodeId).split("-")[1])?.push(scan);
  }
  return byShortId;
}

// What QC has recorded on this order's pieces, per work order, by unit
// number: scrapped, sent back for rework and not yet cleared, and every
// piece QC has seen. A piece's state comes from qcStages.pieceProgressMany,
// the reading the QC screens use, so the numbers agree with them.
async function qcUnits(workOrders) {
  const byShortId = new Map(
    workOrders.map((wo) => [
      shortIdOf(wo._id),
      {
        quantity: wo.quantity || 0,
        seen: new Set(),
        rejected: new Set(),
        rework: new Set(),
        latestAt: null,
      },
    ]),
  );
  if (!workOrders.length) return byShortId;

  const inspections = await QCInspection.find({
    workOrderShortId: { $in: [...byShortId.keys()] },
  })
    .select("barcodeId workOrderShortId inspectedAt")
    .lean();
  if (!inspections.length) return byShortId;

  const progress = await qcStages.pieceProgressMany(
    inspections.map((i) => i.barcodeId),
  );
  for (const insp of inspections) {
    const qc = byShortId.get(insp.workOrderShortId);
    const unit = qc && unitOf(insp.barcodeId, qc.quantity);
    if (!unit) continue;
    qc.seen.add(unit);
    qc.latestAt = latestOf(qc.latestAt, insp.inspectedAt);
    const p = progress[String(insp.barcodeId).trim()];
    if (p?.rejected) qc.rejected.add(unit);
    else if (p?.openRework?.length) qc.rework.add(unit);
  }
  return byShortId;
}

// One work order's production stages, in order, each with the pieces that
// have cleared it: the rollup's unit numbers plus the scans since. A scan
// counts at the stages whose codes were active on the machine, as in the
// production sync.
function stageProgress(wo, scans) {
  const quantity = wo.quantity || 0;
  const stored = new Map(
    (wo.productionCompletion?.operationCompletion || []).map((op) => [
      Number(op.operationNumber),
      op,
    ]),
  );
  const stages = (wo.operations || []).length
    ? wo.operations.map((op, i) => ({
        number: i + 1,
        name: op.operationType,
        code: op.operationCode,
      }))
    : [...stored.values()]
        .map((op) => ({
          number: Number(op.operationNumber),
          name: op.operationType,
          code: op.operationCode,
        }))
        .filter((st) => st.number > 0)
        .sort((a, b) => a.number - b.number);

  // A rollup written before unit numbers were kept has counts only.
  let unitLevel = true;
  const units = new Map();
  for (const st of stages) {
    const op = stored.get(st.number);
    const list = (op?.completedUnitNumbers || []).filter(
      (u) => u >= 1 && u <= quantity,
    );
    if (!list.length && (op?.completedQuantity || 0) > 0) unitLevel = false;
    units.set(st.number, new Set(list));
  }

  let latestScanAt = null;
  for (const scan of scans) {
    const unit = unitOf(scan.barcodeId, quantity);
    if (!unit) continue;
    latestScanAt = latestOf(latestScanAt, scan.timeStamp);
    for (const n of productionSync.resolveActiveOpsCodesToOperationNumbers(
      scan.activeOps,
      wo.operations,
    )) {
      units.get(n)?.add(unit);
    }
  }

  return {
    unitLevel,
    units,
    latestScanAt,
    stages: stages.map((st) => ({
      number: st.number,
      name: st.name || st.code || `Stage ${st.number}`,
      code: st.code || "",
      done: Math.min(
        quantity,
        Math.max(
          units.get(st.number).size,
          unitLevel ? 0 : stored.get(st.number)?.completedQuantity || 0,
        ),
      ),
      total: quantity,
    })),
  };
}

// Every piece counted in exactly one place. Rejected: scrapped by QC,
// whatever else happened to it. Completed: cleared every stage and not
// waiting on rework. In process: scanned at a stage or by QC and not yet
// completed, rework included (inRework says how many). Not started: no
// scan yet.
function pieceCounts(wo, live, qc) {
  const total = wo.quantity || 0;
  const rejected = qc.rejected.size;
  const inRework = qc.rework.size;

  if (live.unitLevel) {
    const started = new Set(qc.seen);
    for (const set of live.units.values()) set.forEach((u) => started.add(u));
    const activeUnits = [...started].filter((u) => !qc.rejected.has(u));
    const sets = [...live.units.values()];
    const cleared = sets.length
      ? activeUnits.filter(
          (u) => !qc.rework.has(u) && sets.every((set) => set.has(u)),
        ).length
      : 0;
    // Completion recorded as a count, without unit numbers (a work order
    // with no stages to scan that was marked done), still counts.
    const recorded = Math.min(
      total,
      wo.productionCompletion?.overallCompletedQuantity || 0,
    );
    const completed = Math.min(
      Math.max(0, total - rejected),
      Math.max(cleared, recorded - rejected - inRework),
    );
    const active = Math.max(activeUnits.length, completed + inRework);
    return {
      total,
      notStarted: Math.max(0, total - active - rejected),
      inProcess: Math.max(0, active - completed),
      inRework,
      completed,
      rejected,
    };
  }

  // Counts only: the closest reading they allow.
  const cleared = Math.min(
    total,
    wo.productionCompletion?.overallCompletedQuantity || 0,
  );
  const started = Math.min(
    total,
    Math.max(cleared, qc.seen.size, ...live.stages.map((st) => st.done)),
  );
  const completed = Math.max(0, cleared - rejected - inRework);
  const inProcess = Math.max(0, started - rejected - completed);
  return {
    total,
    notStarted: Math.max(0, total - inProcess - completed - rejected),
    inProcess,
    inRework,
    completed,
    rejected,
  };
}

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

    const workOrders = await WorkOrder.find({ customerRequestId: cr._id })
      .select(
        "workOrderNumber stockItemId stockItemName stockItemReference " +
          "quantity variantAttributes status operations " +
          "productionCompletion packagedQuantity dispatchedQuantity " +
          "dispatchRecords timeline createdAt",
      )
      .populate({
        path: "stockItemId",
        select:
          "name reference images variants.images variants.attributes " +
          "gender genderCategory category",
      })
      .sort({ createdAt: 1 })
      .lean();

    // Live piece progress, from the scanners and QC.
    const [scansByShortId, qcByShortId] = await Promise.all([
      recentScans(workOrders),
      qcUnits(workOrders),
    ]);

    const products = workOrders.map((wo) => {
      const pc = wo.productionCompletion || {};
      const shortId = shortIdOf(wo._id);
      const live = stageProgress(wo, scansByShortId.get(shortId) || []);
      const qc = qcByShortId.get(shortId);
      const total = wo.quantity || 0;
      const completed = pc.overallCompletedQuantity || 0;
      const packaged = wo.packagedQuantity || 0;

      // ★ Use the safer computed dispatched value, capped at total ★
      const dispatched = Math.min(total, computeDispatched(wo));

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

      const productImage = resolveProductImage(
        wo.stockItemId,
        wo.variantAttributes,
      );

      // Gender info — StockItem.genderCategory is the canonical field, with
      // older docs falling back to .gender. Empty string if not set.
      const stockItem = wo.stockItemId;
      const productGender =
        stockItem?.genderCategory || stockItem?.gender || "";
      const productCategory = stockItem?.category || "";

      return {
        workOrderId: wo._id,
        workOrderNumber: wo.workOrderNumber,
        productName: wo.stockItemName || wo.stockItemId?.name || "—",
        productRef: wo.stockItemReference || wo.stockItemId?.reference || "",
        productImage,
        productGender,
        productCategory,
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

        // Live, from the scanners and QC.
        pieces: pieceCounts(wo, live, qc),
        stages: live.stages,
        updatedAt: latestOf(live.latestScanAt, qc.latestAt, pc.lastSyncedAt),
      };
    });

    const pieces = products.reduce(
      (acc, p) => {
        for (const key of Object.keys(acc)) acc[key] += p.pieces[key];
        return acc;
      },
      { total: 0, notStarted: 0, inProcess: 0, inRework: 0, completed: 0, rejected: 0 },
    );

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

    // Dispatch events — flatten all dispatchRecords across WOs, newest first
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

    // Person-wise summary (employee counts by stage)
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
            dispatchedUnits: {
              $sum: { $cond: ["$isDispatched", "$totalUnits", 0] },
            },
            anyDispatched: { $max: { $cond: ["$isDispatched", 1, 0] } },
            allDispatched: { $min: { $cond: ["$isDispatched", 1, 0] } },
          },
        },
      ]);

      const counts = agg.reduce(
        (acc, e) => {
          acc.totalEmployees += 1;
          acc.totalUnits += e.totalUnits || 0;
          acc.completedUnits += e.completedUnits || 0;
          acc.dispatchedUnits += e.dispatchedUnits || 0;
          if (e.completedUnits >= e.totalUnits && e.totalUnits > 0)
            acc.fullyCompleted += 1;
          else if (e.completedUnits > 0) acc.inProgress += 1;
          else acc.notStarted += 1;
          if (e.packagedUnits >= e.totalUnits && e.totalUnits > 0)
            acc.fullyPackaged += 1;
          if (e.anyDispatched) acc.dispatched += 1;
          if (e.allDispatched) acc.allDispatched += 1;
          return acc;
        },
        {
          totalEmployees: 0,
          notStarted: 0,
          inProgress: 0,
          fullyCompleted: 0,
          fullyPackaged: 0,
          dispatched: 0,
          allDispatched: 0,
          totalUnits: 0,
          completedUnits: 0,
          dispatchedUnits: 0,
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
        pieces,
      },
      updatedAt: latestOf(...products.map((p) => p.updatedAt)),
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
// Paginated employee progress. Returns dispatched units per person.
// ?full=true → returns ALL products per employee (default slices to 5)
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
      500,
      Math.max(1, parseInt(req.query.limit, 10) || 50),
    );
    const skip = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const stage = String(req.query.stage || "all").trim();
    const sort = String(req.query.sort || "name-asc").trim();
    const full = String(req.query.full || "").toLowerCase() === "true";

    const pipeline = [
      { $match: { manufacturingOrderId: new mongoose.Types.ObjectId(cr._id) } },
    ];

    if (search) {
      const regex = new RegExp(
        search.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
        "i",
      );
      pipeline.push({
        $match: {
          $or: [{ employeeName: regex }, { employeeUIN: regex }],
        },
      });
    }

    // Join WorkOrder to pull stockItemName + Reference + variantAttributes
    pipeline.push({
      $lookup: {
        from: WorkOrder.collection.name,
        localField: "workOrderId",
        foreignField: "_id",
        as: "_wo",
        pipeline: [
          {
            $project: {
              stockItemName: 1,
              stockItemReference: 1,
              variantAttributes: 1,
              workOrderNumber: 1,
            },
          },
        ],
      },
    });

    pipeline.push({
      $addFields: {
        productNameResolved: {
          $ifNull: [
            "$productName",
            { $arrayElemAt: ["$_wo.stockItemName", 0] },
          ],
        },
        productRefResolved: { $arrayElemAt: ["$_wo.stockItemReference", 0] },
        productVariantAttrs: {
          $arrayElemAt: ["$_wo.variantAttributes", 0],
        },
        workOrderNumberResolved: {
          $arrayElemAt: ["$_wo.workOrderNumber", 0],
        },
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
        // ★ NEW: sum dispatched UNITS (not just count of dispatched WOs) ★
        dispatchedUnits: {
          $sum: { $cond: ["$isDispatched", "$totalUnits", 0] },
        },
        productCount: { $sum: 1 },
        dispatchedDocs: { $sum: { $cond: ["$isDispatched", 1, 0] } },
        lastSyncedAt: { $max: "$lastSyncedAt" },
        products: {
          $push: {
            productName: "$productNameResolved",
            productRef: "$productRefResolved",
            variantAttributes: "$productVariantAttrs",
            workOrderNumber: "$workOrderNumberResolved",
            workOrderId: "$workOrderId",
            totalUnits: "$totalUnits",
            completedUnits: "$completedUnits",
            packagedUnits: "$packagedUnits",
            isDispatched: "$isDispatched",
            dispatchedUnits: {
              $cond: ["$isDispatched", "$totalUnits", 0],
            },
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
        dispatchedPct: {
          $cond: [
            { $gt: ["$totalUnits", 0] },
            {
              $multiply: [
                { $divide: ["$dispatchedUnits", "$totalUnits"] },
                100,
              ],
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
      "dispatch-asc": { dispatchedPct: 1 },
      "dispatch-desc": { dispatchedPct: -1 },
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

    const employees = (agg.rows || []).map((e) => {
      const allProducts = (e.products || []).map((p) => ({
        productName: p.productName || "—",
        productRef: p.productRef || "",
        variantAttributes: p.variantAttributes || [],
        workOrderNumber: p.workOrderNumber || "",
        workOrderId: p.workOrderId || null,
        totalUnits: p.totalUnits || 0,
        completedUnits: p.completedUnits || 0,
        packagedUnits: p.packagedUnits || 0,
        dispatchedUnits: p.dispatchedUnits || 0,
        isDispatched: !!p.isDispatched,
      }));

      return {
        employeeId: e._id,
        employeeName: e.employeeName || "—",
        employeeUIN: e.employeeUIN || "—",
        gender: e.gender || "",
        productCount: e.productCount || 0,
        products: full ? allProducts : allProducts.slice(0, 5),
        totalUnits: e.totalUnits || 0,
        completedUnits: e.completedUnits || 0,
        packagedUnits: e.packagedUnits || 0,
        dispatchedUnits: e.dispatchedUnits || 0,
        completionPct: Math.round(e.completionPct || 0),
        packagedPct: Math.round(e.packagedPct || 0),
        dispatchedPct: Math.round(e.dispatchedPct || 0),
        stage: e.stage || "not_started",
        lastSyncedAt: e.lastSyncedAt || null,
      };
    });

    res.json({
      success: true,
      employees,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: { search, stage, sort, full },
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
