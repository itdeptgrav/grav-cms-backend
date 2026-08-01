/**
 * routes/CEO_Routes/commandCenter.js
 * Cross-department aggregations for the CEO command-center dashboard:
 *   GET /orders      — every manufacturing order with its full stage journey
 *   GET /order/:id   — one order drilled down to per-WO / per-person detail
 *   GET /pulse       — pipeline funnel + N-day cross-department trends + alerts
 * Register: app.use("/api/ceo/command-center", require("./routes/CEO_Routes/commandCenter"));
 */
"use strict";
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { readToken } = require("../../config/jwt");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Measurement = require("../../models/Customer_Models/Measurement");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const QCInspection = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const ProductionTracking = require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const EmbroideryRecord = require("../../models/CMS_Models/Manufacturing/Embroidery/EmbroideryRecord");
const ReturnRequest = require("../../models/CMS_Models/Manufacturing/Return/ReturnRequest");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const Sop = require("../../models/sopmodel/sop_model");

function ceoAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token)
      return res.status(401).json({ success: false, message: "Auth required" });
    const d = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res
        .status(403)
        .json({ success: false, message: "CEO access required" });
    req.ceoUser = d;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}
router.use(ceoAuth);

// IST day string "YYYY-MM-DD" — same convention as QC/Embroidery/CuttingMaster.
const istDayStr = (d) => {
  const ist = new Date((d ? new Date(d).getTime() : Date.now()) + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};
const lastNDayStrs = (n) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--)
    out.push(istDayStr(Date.now() - i * 24 * 3600 * 1000));
  return out;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (done, total) =>
  total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

// Stored statuses after quotation_sales_approved are rarely written; the real
// progress lives on the WorkOrders. PRE buckets are pure request-status.
const PRE_APPROVAL = [
  "pending",
  "pending_edit_approval",
  "in_progress",
  "quotation_draft",
  "quotation_sent",
  "quotation_customer_approved",
];
const CLOSED = ["completed", "cancelled"];

const woDispatched = (wo) =>
  Math.min(
    num(wo.quantity),
    Math.max(
      num(wo.dispatchedQuantity),
      (wo.dispatchRecords || []).reduce((s, r) => s + num(r.dispatchedQuantity), 0),
    ),
  );

/**
 * Build the stage journey for one request given its work orders and QC rollup.
 * Stages: sales → store → cutting → production → qc → packaging → dispatch.
 */
function buildJourney(reqDoc, wos, qc, measurement) {
  const q = (reqDoc.quotations || [])[0] || {};
  const totalUnits = wos.reduce((s, w) => s + num(w.quantity), 0);
  const produced = wos.reduce(
    (s, w) => s + num(w.productionCompletion?.overallCompletedQuantity),
    0,
  );
  const packaged = wos.reduce((s, w) => s + num(w.packagedQuantity), 0);
  const dispatched = wos.reduce((s, w) => s + woDispatched(w), 0);
  const storeVerified = wos.filter((w) => w.storeDepartmentVerified).length;

  // Cutting: bulk orders track cuttingProgress on the WO; measurement orders
  // mark per-employee products qrGenerated on the Measurement doc.
  let cutDone = 0;
  let cutTotal = totalUnits;
  if (reqDoc.requestType === "measurement_conversion" && measurement) {
    let done = 0;
    let all = 0;
    for (const em of measurement.employeeMeasurements || []) {
      for (const p of em.products || []) {
        all += 1;
        if (p.qrGenerated) done += 1;
      }
    }
    cutDone = done;
    cutTotal = all;
  } else {
    cutDone = wos.reduce((s, w) => s + num(w.cuttingProgress?.completed), 0);
  }

  const salesApproved =
    Boolean(q.salesApproval?.approvedAt) ||
    !PRE_APPROVAL.concat("cancelled", "on_hold").includes(reqDoc.status);

  const stages = [
    {
      key: "sales",
      label: "Sales & quotation",
      done: q.sentToCustomerAt || null,
      approvedByCustomer: q.customerApproval?.approvedAt || null,
      approvedBySales: q.salesApproval?.approvedAt || null,
      pct: salesApproved
        ? 100
        : q.customerApproval?.approvedAt
          ? 80
          : q.sentToCustomerAt
            ? 60
            : ["quotation_draft"].includes(reqDoc.status)
              ? 40
              : 15,
      state: salesApproved ? "done" : "active",
    },
    {
      key: "store",
      label: "Store verification",
      pct: pct(storeVerified, wos.length),
      detail: `${storeVerified}/${wos.length} WOs verified`,
      state:
        wos.length === 0
          ? "pending"
          : storeVerified >= wos.length
            ? "done"
            : storeVerified > 0
              ? "active"
              : "pending",
    },
    {
      key: "cutting",
      label: "Cutting",
      pct: pct(cutDone, cutTotal),
      detail: `${cutDone}/${cutTotal} ${reqDoc.requestType === "measurement_conversion" ? "products" : "units"} cut`,
      state: cutTotal > 0 && cutDone >= cutTotal ? "done" : cutDone > 0 ? "active" : "pending",
    },
    {
      key: "production",
      label: "Production",
      pct: pct(produced, totalUnits),
      detail: `${produced}/${totalUnits} units sewn`,
      state:
        totalUnits > 0 && produced >= totalUnits
          ? "done"
          : produced > 0
            ? "active"
            : "pending",
    },
    {
      key: "qc",
      label: "Quality check",
      pct:
        qc.total > 0 ? Math.round(((qc.passed || 0) / qc.total) * 100) : 0,
      detail: qc.total
        ? `${qc.passed} passed · ${qc.defective} defective`
        : "no inspections yet",
      passRate: qc.total ? Math.round(((qc.passed || 0) / qc.total) * 100) : null,
      state: qc.total > 0 ? (qc.defective > 0 ? "active" : "done") : "pending",
    },
    {
      key: "packaging",
      label: "Packaging",
      pct: pct(packaged, totalUnits),
      detail: `${packaged}/${totalUnits} packed`,
      state:
        totalUnits > 0 && packaged >= totalUnits
          ? "done"
          : packaged > 0
            ? "active"
            : "pending",
    },
    {
      key: "dispatch",
      label: "Dispatch",
      pct: pct(dispatched, totalUnits),
      detail: `${dispatched}/${totalUnits} dispatched`,
      state:
        totalUnits > 0 && dispatched >= totalUnits
          ? "done"
          : dispatched > 0
            ? "active"
            : "pending",
    },
  ];

  // Current stage = first non-done stage; fully dispatched → delivered.
  let currentStage = "sales";
  for (const s of stages) {
    currentStage = s.key;
    if (s.state !== "done") break;
  }
  if (totalUnits > 0 && dispatched >= totalUnits) currentStage = "delivered";
  if (CLOSED.includes(reqDoc.status)) currentStage = reqDoc.status;

  const deadline =
    reqDoc.customerInfo?.deliveryDeadline || reqDoc.estimatedCompletion || null;
  let risk = "none";
  if (deadline && !CLOSED.includes(reqDoc.status) && currentStage !== "delivered") {
    const daysLeft = Math.ceil(
      (new Date(deadline).getTime() - Date.now()) / (24 * 3600 * 1000),
    );
    if (daysLeft < 0) risk = "overdue";
    else if (daysLeft <= 2) risk = "due_soon";
    else if (daysLeft <= 7 && pct(dispatched, totalUnits) < 50) risk = "at_risk";
    else risk = "on_track";
  }

  return {
    stages,
    currentStage,
    totalUnits,
    produced,
    packaged,
    dispatched,
    completionPct: pct(dispatched, totalUnits),
    productionPct: pct(produced, totalUnits),
    deadline,
    risk,
  };
}

async function qcByOrder(requestIds) {
  const rows = await QCInspection.aggregate([
    { $match: { manufacturingOrderId: { $in: requestIds } } },
    {
      $group: {
        _id: "$manufacturingOrderId",
        total: { $sum: 1 },
        passed: { $sum: { $cond: [{ $eq: ["$status", "passed"] }, 1, 0] } },
        defective: {
          $sum: { $cond: [{ $eq: ["$status", "defective"] }, 1, 0] },
        },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows)
    map.set(String(r._id), {
      total: r.total,
      passed: r.passed,
      defective: r.defective,
    });
  return map;
}

/* ─────────────────────────── GET /orders ─────────────────────────── */
router.get("/orders", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 12));
    const search = (req.query.search || "").trim();
    const scope = req.query.scope || "active"; // active | all | completed

    const filter = {};
    if (scope === "active") filter.status = { $nin: CLOSED };
    else if (scope === "completed") filter.status = { $in: CLOSED };
    if (search) {
      filter.$or = [
        { requestId: { $regex: search, $options: "i" } },
        { "customerInfo.name": { $regex: search, $options: "i" } },
        { measurementName: { $regex: search, $options: "i" } },
      ];
    }

    const [total, requests] = await Promise.all([
      CustomerRequest.countDocuments(filter),
      CustomerRequest.find(filter)
        .select(
          "requestId status requestType priority customerInfo.name customerInfo.deliveryDeadline estimatedCompletion actualCompletion finalOrderPrice totalPaidAmount totalDueAmount quotations.sentToCustomerAt quotations.customerApproval.approvedAt quotations.salesApproval.approvedAt measurementId measurementName createdAt isInternalOrder",
        )
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const ids = requests.map((r) => r._id);
    const [wos, qcMap, measurements] = await Promise.all([
      WorkOrder.find({ customerRequestId: { $in: ids } })
        .select(
          "customerRequestId workOrderNumber stockItemName variantAttributes quantity status storeDepartmentVerified cuttingStatus cuttingProgress productionCompletion.overallCompletedQuantity productionCompletion.invalidScansCount packagedQuantity dispatchedQuantity dispatchRecords.dispatchedQuantity timeline.actualStartDate timeline.actualEndDate",
        )
        .lean(),
      qcByOrder(ids),
      Measurement.find({
        _id: {
          $in: requests.map((r) => r.measurementId).filter(Boolean),
        },
      })
        .select("employeeMeasurements.products.qrGenerated")
        .lean(),
    ]);

    const wosByReq = new Map();
    for (const w of wos) {
      const k = String(w.customerRequestId);
      if (!wosByReq.has(k)) wosByReq.set(k, []);
      wosByReq.get(k).push(w);
    }
    const measById = new Map(measurements.map((m) => [String(m._id), m]));

    const orders = requests.map((r) => {
      const rw = wosByReq.get(String(r._id)) || [];
      const journey = buildJourney(
        r,
        rw,
        qcMap.get(String(r._id)) || { total: 0, passed: 0, defective: 0 },
        r.measurementId ? measById.get(String(r.measurementId)) : null,
      );
      return {
        _id: r._id,
        requestId: r.requestId,
        moNumber: `MO-${r.requestId || String(r._id).slice(-6)}`,
        customerName: r.customerInfo?.name || r.measurementName || "—",
        requestType: r.requestType,
        isInternalOrder: Boolean(r.isInternalOrder),
        status: r.status,
        priority: r.priority,
        createdAt: r.createdAt,
        finalOrderPrice: num(r.finalOrderPrice),
        totalPaidAmount: num(r.totalPaidAmount),
        totalDueAmount: num(r.totalDueAmount),
        workOrdersCount: rw.length,
        invalidScans: rw.reduce(
          (s, w) => s + num(w.productionCompletion?.invalidScansCount),
          0,
        ),
        ...journey,
      };
    });

    res.json({
      success: true,
      orders,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("command-center /orders error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────── GET /order/:id ─────────────────────────── */
router.get("/order/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Bad id" });

    const r = await CustomerRequest.findById(req.params.id).lean();
    if (!r)
      return res.status(404).json({ success: false, message: "Not found" });

    const [wos, qcAgg, defects, persons, measurement, returns] =
      await Promise.all([
        WorkOrder.find({ customerRequestId: r._id }).lean(),
        qcByOrder([r._id]),
        QCInspection.find({ manufacturingOrderId: r._id, status: "defective" })
          .sort({ inspectedAt: -1 })
          .limit(50)
          .select("barcodeId defects inspectedAt inspectedByQCName date")
          .lean(),
        EmployeeProductionProgress.find({ manufacturingOrderId: r._id })
          .select(
            "employeeName employeeUIN totalUnits completedUnits packagedUnits isDispatched workOrderId",
          )
          .limit(600)
          .lean(),
        r.measurementId
          ? Measurement.findById(r.measurementId)
              .select("employeeMeasurements.products.qrGenerated")
              .lean()
          : null,
        ReturnRequest.find({ originalMoId: r._id })
          .select("returnRequestNumber status createdAt")
          .lean(),
      ]);

    const qc = qcAgg.get(String(r._id)) || { total: 0, passed: 0, defective: 0 };
    const journey = buildJourney(r, wos, qc, measurement);
    const q = (r.quotations || [])[0] || {};
    // Older dev data has WOs without a workOrderNumber — fall back to short id.
    const woNo = (w) => w.workOrderNumber || `WO-${String(w._id).slice(-8)}`;

    // Chronological event timeline stitched from every stage's timestamps.
    const events = [];
    const push = (at, label, dept) => {
      if (at) events.push({ at, label, dept });
    };
    push(r.createdAt, "Order created", "sales");
    push(r.processingStartedAt, "Sales started processing", "sales");
    push(q.sentToCustomerAt, "Quotation sent to customer", "sales");
    push(q.customerApproval?.approvedAt, "Customer approved quotation", "customer");
    push(q.salesApproval?.approvedAt, "Sales approved — work orders created", "sales");
    for (const w of wos) {
      push(w.storeDepartmentVerifiedAt, `Store verified ${woNo(w)}`, "store");
      push(
        w.timeline?.actualStartDate,
        `Production started ${woNo(w)}`,
        "production",
      );
      push(
        w.timeline?.actualEndDate,
        `Production completed ${woNo(w)}`,
        "production",
      );
      for (const p of w.packagingRecords || [])
        push(
          p.packagedAt,
          `Packed ${p.packagedQuantity} units (${woNo(w)})`,
          "packaging",
        );
      for (const d of w.dispatchRecords || [])
        push(
          d.dispatchedAt,
          `Dispatched ${d.dispatchedQuantity} units (${woNo(w)})`,
          "dispatch",
        );
    }
    push(r.actualCompletion, "Order completed", "sales");
    events.sort((a, b) => new Date(a.at) - new Date(b.at));

    const workOrders = wos.map((w) => ({
      _id: w._id,
      workOrderNumber: woNo(w),
      stockItemName: w.stockItemName,
      variantAttributes: w.variantAttributes,
      quantity: num(w.quantity),
      status: w.status,
      priority: w.priority,
      storeVerified: Boolean(w.storeDepartmentVerified),
      cuttingStatus: w.cuttingStatus || "pending",
      cutUnits: num(w.cuttingProgress?.completed),
      producedUnits: num(w.productionCompletion?.overallCompletedQuantity),
      productionPct: num(w.productionCompletion?.overallCompletionPercentage),
      packagedUnits: num(w.packagedQuantity),
      dispatchedUnits: woDispatched(w),
      invalidScans: num(w.productionCompletion?.invalidScansCount),
      estimatedCost: num(w.estimatedCost),
      operations: (w.productionCompletion?.operationCompletion || []).map(
        (o) => ({
          operationCode: o.operationCode,
          completedQuantity: num(o.completedQuantity),
          completionPercentage: num(o.completionPercentage),
          status: o.status,
        }),
      ),
    }));

    // Defect rollup by operation for the drilldown.
    const byOperation = {};
    for (const d of defects)
      for (const def of d.defects || []) {
        const k = `${def.operationCode || "?"} ${def.operationName || ""}`.trim();
        byOperation[k] = (byOperation[k] || 0) + 1;
      }

    res.json({
      success: true,
      order: {
        _id: r._id,
        requestId: r.requestId,
        moNumber: `MO-${r.requestId || String(r._id).slice(-6)}`,
        customerName: r.customerInfo?.name || r.measurementName || "—",
        customerEmail: r.customerInfo?.email,
        requestType: r.requestType,
        isInternalOrder: Boolean(r.isInternalOrder),
        status: r.status,
        priority: r.priority,
        createdAt: r.createdAt,
        finalOrderPrice: num(r.finalOrderPrice),
        totalPaidAmount: num(r.totalPaidAmount),
        totalDueAmount: num(r.totalDueAmount),
        ...journey,
      },
      workOrders,
      qc: { ...qc, byOperation, recentDefects: defects.slice(0, 12) },
      persons: persons.map((p) => ({
        name: p.employeeName,
        uin: p.employeeUIN,
        totalUnits: num(p.totalUnits),
        completedUnits: num(p.completedUnits),
        packagedUnits: num(p.packagedUnits),
        isDispatched: Boolean(p.isDispatched),
      })),
      returns,
      events,
    });
  } catch (err) {
    console.error("command-center /order/:id error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ─────────────────────────── GET /pulse ─────────────────────────── */
router.get("/pulse", async (req, res) => {
  try {
    const days = Math.min(31, Math.max(3, parseInt(req.query.days) || 7));
    const dayStrs = lastNDayStrs(days);
    const from = new Date(Date.now() - days * 24 * 3600 * 1000);

    const [
      statusCounts,
      woCounts,
      qcTrend,
      cutTrend,
      embTrend,
      packTrendRaw,
      dispTrendRaw,
      trackingDocs,
      attendanceDocs,
      overdueOrders,
      pendingSops,
      openReturns,
    ] = await Promise.all([
      CustomerRequest.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      WorkOrder.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      QCInspection.aggregate([
        { $match: { date: { $in: dayStrs } } },
        {
          $group: {
            _id: "$date",
            total: { $sum: 1 },
            passed: { $sum: { $cond: [{ $eq: ["$status", "passed"] }, 1, 0] } },
            defective: {
              $sum: { $cond: [{ $eq: ["$status", "defective"] }, 1, 0] },
            },
          },
        },
      ]),
      CuttingMasterRecord.aggregate([
        { $match: { date: { $in: dayStrs } } },
        { $group: { _id: "$date", units: { $sum: "$totalUnitsCut" } } },
      ]),
      EmbroideryRecord.aggregate([
        { $match: { date: { $in: dayStrs } } },
        { $group: { _id: "$date", pieces: { $sum: 1 } } },
      ]),
      WorkOrder.aggregate([
        { $unwind: "$packagingRecords" },
        { $match: { "packagingRecords.packagedAt": { $gte: from } } },
        {
          $group: {
            _id: null,
            rows: {
              $push: {
                at: "$packagingRecords.packagedAt",
                qty: "$packagingRecords.packagedQuantity",
              },
            },
          },
        },
      ]),
      WorkOrder.aggregate([
        { $unwind: "$dispatchRecords" },
        { $match: { "dispatchRecords.dispatchedAt": { $gte: from } } },
        {
          $group: {
            _id: null,
            rows: {
              $push: {
                at: "$dispatchRecords.dispatchedAt",
                qty: "$dispatchRecords.dispatchedQuantity",
              },
            },
          },
        },
      ]),
      ProductionTracking.find({ date: { $gte: from } })
        .select("date machines.operators.barcodeScans.barcodeId")
        .lean(),
      DailyAttendance.find({ dateStr: { $in: dayStrs } })
        .select("dateStr summary.presentCount summary.AB summary.total")
        .lean(),
      CustomerRequest.find({
        status: { $nin: CLOSED },
        "customerInfo.deliveryDeadline": { $ne: null, $lt: new Date() },
      })
        .select("requestId customerInfo.name customerInfo.deliveryDeadline status")
        .sort({ "customerInfo.deliveryDeadline": 1 })
        .limit(20)
        .lean(),
      Sop.countDocuments({ status: "pending" }),
      ReturnRequest.find({ status: { $in: ["pending", "store_processing"] } })
        .select("returnRequestNumber status createdAt")
        .limit(20)
        .lean(),
    ]);

    // Funnel over request statuses (post-approval progress lives on WOs).
    const sc = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));
    const funnel = {
      enquiry: num(sc.pending) + num(sc.pending_edit_approval) + num(sc.in_progress),
      quotation:
        num(sc.quotation_draft) +
        num(sc.quotation_sent) +
        num(sc.quotation_customer_approved),
      inProduction:
        num(sc.quotation_sales_approved) +
        num(sc.production) +
        num(sc.shipping) +
        num(sc.delivered),
      completed: num(sc.completed),
      cancelled: num(sc.cancelled),
      onHold: num(sc.on_hold),
    };
    const wc = Object.fromEntries(woCounts.map((s) => [s._id, s.count]));
    const workOrders = {
      pending:
        num(wc.pending) +
        num(wc.planned) +
        num(wc.scheduled) +
        num(wc.ready_to_start) +
        num(wc.partial_allocation),
      inProgress: num(wc.in_progress) + num(wc.paused) + num(wc.delayed),
      completed: num(wc.completed),
      forwarded: num(wc.forwarded),
      cancelled: num(wc.cancelled),
    };

    // Floor pieces/scans per IST-adjacent day from ProductionTracking docs.
    const floorByDay = new Map();
    for (const doc of trackingDocs) {
      const key = istDayStr(doc.date);
      let scans = 0;
      const pieces = new Set();
      for (const m of doc.machines || [])
        for (const op of m.operators || [])
          for (const s of op.barcodeScans || []) {
            scans += 1;
            if (s.barcodeId) pieces.add(s.barcodeId);
          }
      const prev = floorByDay.get(key) || { scans: 0, pieces: 0 };
      floorByDay.set(key, {
        scans: prev.scans + scans,
        pieces: prev.pieces + pieces.size,
      });
    }

    const sumByDay = (rows) => {
      const m = new Map();
      for (const r of rows || []) {
        const k = istDayStr(r.at);
        m.set(k, (m.get(k) || 0) + num(r.qty));
      }
      return m;
    };
    const packByDay = sumByDay(packTrendRaw[0]?.rows);
    const dispByDay = sumByDay(dispTrendRaw[0]?.rows);
    const qcByDay = new Map(qcTrend.map((r) => [r._id, r]));
    const cutByDay = new Map(cutTrend.map((r) => [r._id, r.units]));
    const embByDay = new Map(embTrend.map((r) => [r._id, r.pieces]));
    const attByDay = new Map(attendanceDocs.map((d) => [d.dateStr, d.summary]));

    const trend = dayStrs.map((d) => {
      const f = floorByDay.get(d) || { scans: 0, pieces: 0 };
      const qcd = qcByDay.get(d) || { total: 0, passed: 0, defective: 0 };
      const att = attByDay.get(d) || {};
      return {
        date: d,
        floorScans: f.scans,
        floorPieces: f.pieces,
        unitsCut: num(cutByDay.get(d)),
        embroidered: num(embByDay.get(d)),
        qcTotal: qcd.total,
        qcPassed: qcd.passed,
        qcDefective: qcd.defective,
        packed: num(packByDay.get(d)),
        dispatched: num(dispByDay.get(d)),
        present: num(att.presentCount),
        absent: num(att.AB),
      };
    });

    res.json({
      success: true,
      days,
      funnel,
      workOrders,
      trend,
      alerts: {
        overdueOrders: overdueOrders.map((o) => ({
          _id: o._id,
          requestId: o.requestId,
          customerName: o.customerInfo?.name || "—",
          deadline: o.customerInfo?.deliveryDeadline,
          status: o.status,
        })),
        pendingSops,
        openReturns,
      },
      generatedAt: new Date(),
    });
  } catch (err) {
    console.error("command-center /pulse error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
