// routes/CMS_Routes/Manufacturing/Embroidery/embroideryRoutes.js
//
// Mount: app.use("/api/cms/manufacturing/embroidery", embroideryRoutes);
//
// Five endpoints. Scanning a piece IS completing it — there is no confirm step,
// no status, no undo. A row exists = that piece is done.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Employee = require("../../../../models/Employee");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");

const EmbroideryRecord = require("../../../../models/CMS_Models/Manufacturing/Embroidery/EmbroideryRecord");
const SpCompanyMembership = require("../../../../models/CMS_Models/StorePurchase/SpCompanyMembership");

/* Who may use Embroidery's floor, and whose work it is — see
   embroideryAccess.js. Reading needs viewer, recording a scan needs editor.
   The manufacturing-order read is shared with the project manager's
   Embroidery tab, so it is company-scoped without the department gate. */
const emb = require("./embroideryAccess");
const canRead = [emb.embroideryDepartment("viewer"), emb.embroideryCompany];
const canRecord = [emb.embroideryDepartment("editor"), emb.embroideryCompany];
const stageTargets = require("../../../../services/production/embroideryStageTarget.service");

/* PPC's published embroidery targets, answered by Embroidery. Declared before
   the ":moId" route below so "stage-targets" is never read as an order id. */
router.use("/stage-targets", require("./stageTargetRoutes"));

/**
 * The operator who did the embroidery, resolved from employee records.
 *
 * The floor screen sends a biometric id — the number on the badge — and
 * nothing else is believed: the name, identity id, department and designation
 * are read from the employee record, so a browser cannot record a piece under
 * somebody else's name. An unknown or inactive badge is refused.
 *
 * Their OWN company cannot be proved from an employee record (it carries
 * none), so when membership rows exist for them one must match the acting
 * company; when none exist the scan is allowed and says `unproven` rather
 * than assigning a company by department or name.
 */
async function resolveOperator(biometricId, companyId) {
  const id = String(biometricId ?? "").trim();
  if (!id) return { error: { status: 400, message: "Biometric ID is required" } };

  const employee = await Employee.findOne({ biometricId: id })
    .select("firstName middleName lastName biometricId identityId department designation isActive status email")
    .lean();
  if (!employee) return { error: { status: 404, message: `No employee found with ID "${id}".` } };
  if (employee.isActive === false || employee.status === "inactive") {
    return { error: { status: 403, message: "This employee account is inactive." } };
  }

  const memberships = await SpCompanyMembership.find({
    isActive: true,
    $or: [
      { employeeRef: employee._id },
      ...(employee.email ? [{ email: String(employee.email).toLowerCase() }] : []),
    ],
  }).select("companyId").lean();
  if (memberships.length && !memberships.some((m) => String(m.companyId) === String(companyId))) {
    /* Their memberships are known, and this company is not one of them. */
    return { error: { status: 404, message: `No employee found with ID "${id}".` } };
  }

  return {
    employee,
    companyProof: memberships.length ? "membership" : "unproven",
    name: [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" ").trim() || id,
  };
}

// ─── Helpers (same semantics as qcRoutes.js) ─────────────────────────────────

const istDateString = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};

const istHour = (d) =>
  new Date(new Date(d).getTime() + 5.5 * 3600000).getUTCHours();

const parseBarcode = (raw) => {
  if (!raw || typeof raw !== "string") return { success: false };
  const parts = raw.trim().split("-");
  if (parts.length !== 3 || parts[0] !== "WO") return { success: false };
  const unit = parseInt(parts[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return { success: false };
  return { success: true, workOrderShortId: parts[1], unitNumber: unit };
};

const shortIdOf = (id) => String(id).slice(16, 24);

const barcodeFor = (woId, unit) =>
  `WO-${shortIdOf(woId)}-${String(unit).padStart(3, "0")}`;

const findWorkOrderByShortId = async (shortId, companyId) => {
  const matches = await WorkOrder.aggregate([
    {
      $match: {
        $expr: {
          $eq: [{ $substrCP: [{ $toString: "$_id" }, 16, 8] }, shortId],
        },
        /* The printed barcode is unchanged; what it may reach is not. */
        ...emb.workOrderScope(companyId),
      },
    },
    { $limit: 1 },
    {
      $project: {
        _id: 1,
        workOrderNumber: 1,
        stockItemName: 1,
        stockItemReference: 1,
        stockItemId: 1,
        quantity: 1,
        status: 1,
        variantAttributes: 1,
        customerRequestId: 1,
        salesLineLink: 1,
      },
    },
  ]);
  return matches[0] || null;
};

const variantLabelOf = (wo) =>
  (wo?.variantAttributes || []).map((a) => `${a.name}: ${a.value}`).join(" · ");

const resolveImage = (wo, stockItem) => {
  if (!stockItem) return null;
  if (wo?.variantAttributes?.length && stockItem.variants?.length) {
    const match = stockItem.variants.find((v) =>
      (v.attributes || []).every((va) =>
        wo.variantAttributes.some(
          (w) =>
            w.name?.toLowerCase() === va.name?.toLowerCase() &&
            String(w.value).toLowerCase() === String(va.value).toLowerCase(),
        ),
      ),
    );
    if (match?.images?.[0]) return match.images[0];
  }
  return stockItem.images?.[0] || null;
};

/**
 * The embroidery records this company may read.
 *
 * Rows written since the scan started stamping a company are matched on it.
 * A row from before that carries none: rather than hiding it from everybody
 * or showing it to everybody, its work order is asked — the Sales-line link
 * is authoritative, and a row whose work order cannot prove this company is
 * not this company's to read.
 */
const scopeRecordsToCompany = async (rows, companyId) => {
  const mine = [];
  const unproven = [];
  for (const r of rows) {
    if (r.companyId && String(r.companyId) === String(companyId)) mine.push(r);
    else if (!r.companyId) unproven.push(r);
  }
  if (!unproven.length) return mine;
  const woIds = [...new Set(unproven.map((r) => String(r.workOrderId || "")).filter(Boolean))];
  const linked = woIds.length
    ? await WorkOrder.find({ _id: { $in: woIds }, ...emb.workOrderScope(companyId) }).select("_id").lean()
    : [];
  const ours = new Set(linked.map((w) => String(w._id)));
  return [...mine, ...unproven.filter((r) => ours.has(String(r.workOrderId || "")))]
    .sort((a, b) => new Date(b.scannedAt || 0) - new Date(a.scannedAt || 0));
};

// Which piece numbers on this work order still have no record.
const pendingUnitsFor = (total, doneUnits) => {
  const done = new Set(doneUnits);
  const out = [];
  for (let u = 1; u <= total; u++) if (!done.has(u)) out.push(u);
  return out;
};

// ═════════════════════════════════════════════════════════════════════════════
// POST /signin
// ═════════════════════════════════════════════════════════════════════════════
router.post("/signin", ...canRead, async (req, res) => {
  try {
    const resolved = await resolveOperator(req.body?.biometricId, req.embroidery.companyId);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    const { employee, name, companyProof } = resolved;

    const today = istDateString();
    const scope = { companyId: req.embroidery.companyId };
    const [mine, dept] = await Promise.all([
      EmbroideryRecord.countDocuments({
        ...scope,
        date: today,
        operatorBiometricId: employee.biometricId,
      }),
      EmbroideryRecord.countDocuments({ ...scope, date: today }),
    ]);

    res.json({
      success: true,
      operator: {
        name,
        biometricId: employee.biometricId,
        identityId: employee.identityId || "",
        department: employee.department || "",
        designation: employee.designation || "",
        /* Whether this operator's own company could be proved. */
        companyProof,
      },
      today: { date: today, piecesDone: mine, departmentTotal: dept },
    });
  } catch (err) {
    console.error("[EMB signin]", err);
    res
      .status(500)
      .json({ success: false, message: "Server error during sign-in" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /scan — the whole department in one call
//
// Look up the piece AND mark it complete in the same round trip. If a record
// already exists we do not create a second one; we return what's already there.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/scan", ...canRecord, async (req, res) => {
  try {
    /* The barcode and the badge are the only things believed from the body:
       the operator's name and identity are read from their employee record,
       and the work order's details from the work order. */
    const { barcode, operatorBiometricId } = req.body;

    if (!barcode)
      return res
        .status(400)
        .json({ success: false, message: "barcode is required" });
    if (!operatorBiometricId)
      return res
        .status(400)
        .json({ success: false, message: "Operator is not signed in" });

    const resolved = await resolveOperator(operatorBiometricId, req.embroidery.companyId);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    const operator = resolved.employee;
    const operatorName = resolved.name;

    const trimmed = String(barcode).trim();
    const parsed = parseBarcode(trimmed);
    if (!parsed.success)
      return res.status(400).json({
        success: false,
        message:
          "Invalid barcode. Expected WO-<id>-<piece>, e.g. WO-57d2c86c-001",
      });

    const { workOrderShortId, unitNumber } = parsed;

    /* This company's work only. A work order of another company, and a
       historical one whose company cannot be proved from its Sales-line link,
       are the same answer as a barcode nobody has — and neither can be
       scanned. Nothing is matched by style, buyer, number or product name. */
    const workOrder = await findWorkOrderByShortId(workOrderShortId, req.embroidery.companyId);
    if (!workOrder)
      return res.status(404).json({
        success: false,
        message: `No work order found for ID "${workOrderShortId}".`,
      });

    const total = workOrder.quantity || 0;
    if (total && unitNumber > total)
      return res.status(400).json({
        success: false,
        message: `Piece ${unitNumber} is out of range — this work order has only ${total} pieces.`,
      });

    const [customerRequest, empProgress, stockItem, existing] =
      await Promise.all([
        workOrder.customerRequestId
          ? CustomerRequest.findById(workOrder.customerRequestId)
              .select("requestId customerInfo requestType")
              .lean()
          : Promise.resolve(null),
        EmployeeProductionProgress.findOne({
          workOrderId: workOrder._id,
          unitStart: { $lte: unitNumber },
          unitEnd: { $gte: unitNumber },
        })
          .select("employeeName employeeUIN")
          .lean(),
        workOrder.stockItemId
          ? StockItem.findById(workOrder.stockItemId)
              .select("name images variants")
              .lean()
          : Promise.resolve(null),
        EmbroideryRecord.findOne({ barcodeId: trimmed }).lean(),
      ]);

    const piece = {
      barcodeId: trimmed,
      unitNumber,
      totalPieces: total,
      workOrderId: workOrder._id,
      workOrderShortId,
      workOrderNumber: workOrder.workOrderNumber || "",
      productName: workOrder.stockItemName || stockItem?.name || "",
      productReference: workOrder.stockItemReference || "",
      variantLabel: variantLabelOf(workOrder),
      imageUrl: resolveImage(workOrder, stockItem),
      moNumber: customerRequest?.requestId
        ? `MO-${customerRequest.requestId}`
        : "",
      customerName: customerRequest?.customerInfo?.name || "",
      stitchedBy: empProgress?.employeeName || "",
    };

    let record = existing;
    let created = false;

    if (!existing) {
      try {
        record = (
          await EmbroideryRecord.create({
            date: istDateString(),
            barcodeId: trimmed,
            workOrderShortId,
            unitNumber,
            workOrderId: workOrder._id,
            moRequestId: customerRequest?._id || null,
            manufacturingOrderId: piece.moNumber,
            productName: piece.productName,
            variantLabel: piece.variantLabel,
            /* Read from the employee record, never from the body. */
            operatorName,
            operatorBiometricId: operator.biometricId,
            operatorIdentityId: operator.identityId || "",
            operatorEmployeeId: operator._id,
            operatorCompanyProof: resolved.companyProof,
            /* And the signed-in user or station that sent it — on a shared
               terminal, not the person who did the work. */
            submittedBy: { id: req.user?.id, name: req.user?.name || "", email: req.user?.email || "" },
            /* Whose work it is, from the work order's own Sales-line link. */
            companyId: req.embroidery.companyId,
            orderLineRef: workOrder.salesLineLink?.lineRef || "",
            scannedAt: new Date(),
          })
        ).toObject();
        created = true;
      } catch (e) {
        // Unique index on barcodeId absorbs a double-fire from the scanner.
        if (e.code === 11000) {
          record = await EmbroideryRecord.findOne({
            barcodeId: trimmed,
          }).lean();
        } else throw e;
      }
    }

    const [doneRows, todayMine, todayDept] = await Promise.all([
      EmbroideryRecord.find({ workOrderId: workOrder._id })
        .select("unitNumber")
        .lean(),
      EmbroideryRecord.countDocuments({
        companyId: req.embroidery.companyId,
        date: istDateString(),
        operatorBiometricId: operator.biometricId,
      }),
      EmbroideryRecord.countDocuments({ companyId: req.embroidery.companyId, date: istDateString() }),
    ]);

    const doneUnits = doneRows.map((r) => r.unitNumber);
    const pendingUnits = pendingUnitsFor(total, doneUnits);

    res.json({
      success: true,
      created,
      alreadyDone: !created,
      piece,
      record,
      progress: {
        done: doneUnits.length,
        total,
        remaining: pendingUnits.length,
        pendingUnits: pendingUnits.slice(0, 40),
        nextUnit: pendingUnits[0] ?? null,
        nextBarcode:
          pendingUnits[0] != null
            ? barcodeFor(workOrder._id, pendingUnits[0])
            : null,
      },
      today: { piecesDone: todayMine, departmentTotal: todayDept },
    });
  } catch (err) {
    console.error("[EMB scan]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /records — ?from= &to= &operator= &search= &limit=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/records", ...canRead, async (req, res) => {
  try {
    const { from, to, operator, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

    const q = {};
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = from;
      if (to) q.date.$lte = to;
    } else {
      q.date = istDateString();
    }
    if (operator) q.operatorBiometricId = String(operator).trim();
    if (search) {
      const rx = new RegExp(
        String(search)
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      q.$or = [
        { barcodeId: rx },
        { productName: rx },
        { manufacturingOrderId: rx },
        { operatorName: rx },
        { workOrderShortId: rx },
      ];
    }

    const dateScope = q.date ? { date: q.date } : {};

    /* Read wide, then keep only what this company can prove is its own —
       and count the operators from exactly those rows. */
    void dateScope;
    const found = await EmbroideryRecord.find(q).sort({ scannedAt: -1 }).limit(limit).lean();
    const records = await scopeRecordsToCompany(found, req.embroidery.companyId);
    const byOperator = new Map();
    for (const r of records) {
      const key = r.operatorBiometricId || "";
      if (!byOperator.has(key)) byOperator.set(key, { _id: key, name: r.operatorName || "", count: 0 });
      byOperator.get(key).count += 1;
    }
    const operators = [...byOperator.values()].sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      total: records.length,
      truncated: records.length === limit,
      records,
      operators: operators.map((o) => ({
        biometricId: o._id,
        name: o.name,
        count: o.count,
      })),
    });
  } catch (err) {
    console.error("[EMB records]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /overview — ?date= &days=
//
// Hour buckets are computed in JS rather than with $hour + timezone, so this
// works on any MongoDB version regardless of tz database availability.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/overview", ...canRead, async (req, res) => {
  try {
    const date = req.query.date || istDateString();
    const days = Math.min(parseInt(req.query.days, 10) || 14, 90);

    const dayKeys = [];
    const anchor = new Date(`${date}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(anchor.getTime() - i * 86400000);
      dayKeys.push(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
    const previousDay = dayKeys[dayKeys.length - 2] || null;

    const [dayRecords, trendRecords] = await Promise.all([
      EmbroideryRecord.find({ date }).sort({ scannedAt: -1 }).lean()
        .then((rows) => scopeRecordsToCompany(rows, req.embroidery.companyId)),
      EmbroideryRecord.find({ date: { $in: dayKeys } })
        .select("date companyId workOrderId scannedAt").lean()
        .then((rows) => scopeRecordsToCompany(rows, req.embroidery.companyId)),
    ]);
    /* Counted from this company's rows only. */
    const trendCounts = new Map();
    for (const r of trendRecords) trendCounts.set(r.date, (trendCounts.get(r.date) || 0) + 1);
    const trendRows = [...trendCounts.entries()].map(([_id, pieces]) => ({ _id, pieces }));

    const trendMap = new Map(trendRows.map((r) => [r._id, r.pieces]));
    const trend = dayKeys.map((d) => ({
      date: d,
      pieces: trendMap.get(d) || 0,
    }));

    const todayTotal = dayRecords.length;
    const previousTotal = previousDay ? trendMap.get(previousDay) || 0 : 0;

    const active = trend.filter((t) => t.pieces > 0);
    const avgPerDay = active.length
      ? Math.round(active.reduce((s, t) => s + t.pieces, 0) / active.length)
      : 0;

    // Operators
    const opMap = new Map();
    for (const r of dayRecords) {
      const k = r.operatorBiometricId;
      if (!opMap.has(k))
        opMap.set(k, {
          biometricId: k,
          name: r.operatorName,
          pieces: 0,
          firstScan: r.scannedAt,
          lastScan: r.scannedAt,
        });
      const o = opMap.get(k);
      o.pieces += 1;
      if (new Date(r.scannedAt) < new Date(o.firstScan))
        o.firstScan = r.scannedAt;
      if (new Date(r.scannedAt) > new Date(o.lastScan))
        o.lastScan = r.scannedAt;
    }
    const operators = [...opMap.values()].sort((a, b) => b.pieces - a.pieces);

    // Hours (IST)
    const hourCounts = new Array(24).fill(0);
    for (const r of dayRecords) hourCounts[istHour(r.scannedAt)] += 1;
    const hours = hourCounts.map((pieces, hour) => ({ hour, pieces }));
    let busiestHour = null;
    hourCounts.forEach((c, h) => {
      if (c > 0 && (busiestHour === null || c > hourCounts[busiestHour]))
        busiestHour = h;
    });

    // Products
    const prodMap = new Map();
    for (const r of dayRecords) {
      const k = r.productName || "Unnamed";
      prodMap.set(k, (prodMap.get(k) || 0) + 1);
    }
    const products = [...prodMap.entries()]
      .map(([name, pieces]) => ({ name, pieces }))
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, 8);

    // Work orders touched today
    const woMap = new Map();
    for (const r of dayRecords) {
      const k = String(r.workOrderId || r.workOrderShortId);
      if (!woMap.has(k))
        woMap.set(k, {
          key: k,
          shortId: r.workOrderShortId,
          productName: r.productName || "—",
          moNumber: r.manufacturingOrderId || "",
          pieces: 0,
        });
      woMap.get(k).pieces += 1;
    }
    const workOrders = [...woMap.values()].sort((a, b) => b.pieces - a.pieces);

    res.json({
      success: true,
      date,
      headline: {
        todayTotal,
        previousTotal,
        delta: todayTotal - previousTotal,
        avgPerDay,
        activeOperators: operators.length,
        workOrdersTouched: workOrders.length,
        busiestHour,
        busiestHourPieces: busiestHour != null ? hourCounts[busiestHour] : 0,
      },
      trend,
      hours,
      operators,
      products,
      workOrders,
      recent: dayRecords.slice(0, 40),
    });
  } catch (err) {
    console.error("[EMB overview]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /queue — every manufacturing order in production, grouped like the
// Cutting Master screen.
//
// Embroidery has no upstream gate — nothing has to "pass" before a piece can be
// embroidered — so this deliberately does NOT filter by an embroidery-ready
// flag. It mirrors cuttingMasterRoutes.js: every work order that has left
// "pending", grouped under its MO, with embroidery progress layered on top.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/queue", ...canRead, async (req, res) => {
  try {
    const search = (req.query.search || "").trim().toLowerCase();

    /* This company's linked work orders only — a historical one whose company
       cannot be proved is in no company's queue. */
    const workOrders = await WorkOrder.find({
      status: { $ne: "pending" },
      ...emb.workOrderScope(req.embroidery.companyId),
    })
      .select(
        "workOrderNumber stockItemName stockItemId stockItemReference quantity status variantAttributes customerRequestId createdAt",
      )
      .sort({ createdAt: -1 })
      .limit(600)
      .lean();

    if (!workOrders.length)
      return res.json({
        success: true,
        orders: [],
        totals: { orders: 0, workOrders: 0, pieces: 0, done: 0, pending: 0 },
      });

    const woIds = workOrders.map((w) => w._id);
    /* PPC's target in force for each of this company's work orders — read
       only; Embroidery answers them on its own door. */
    const targetByWorkOrder = await stageTargets.targetsByWorkOrder(
      req.embroidery.companyId, woIds.map(String),
    );
    const crIds = [
      ...new Set(
        workOrders
          .map((w) => w.customerRequestId)
          .filter(Boolean)
          .map(String),
      ),
    ];
    const siIds = [
      ...new Set(
        workOrders
          .map((w) => w.stockItemId)
          .filter(Boolean)
          .map(String),
      ),
    ];

    const [counts, requests, stockItems] = await Promise.all([
      EmbroideryRecord.aggregate([
        { $match: { workOrderId: { $in: woIds } } },
        {
          $group: {
            _id: "$workOrderId",
            done: { $sum: 1 },
            lastScan: { $max: "$scannedAt" },
            units: { $addToSet: "$unitNumber" },
          },
        },
      ]),
      CustomerRequest.find({ _id: { $in: crIds } })
        .select("requestId customerInfo requestType status createdAt")
        .lean(),
      StockItem.find({ _id: { $in: siIds } })
        .select("name images variants")
        .lean(),
    ]);

    const countMap = new Map(counts.map((c) => [String(c._id), c]));
    const reqMap = new Map(requests.map((r) => [String(r._id), r]));
    const siMap = new Map(stockItems.map((s) => [String(s._id), s]));

    const orderMap = new Map();

    for (const wo of workOrders) {
      const c = countMap.get(String(wo._id));
      const total = wo.quantity || 0;
      const doneUnits = (c?.units || []).slice().sort((a, b) => a - b);
      const done = doneUnits.length;
      const pending = pendingUnitsFor(total, doneUnits);
      const cr = wo.customerRequestId
        ? reqMap.get(String(wo.customerRequestId))
        : null;
      const si = wo.stockItemId ? siMap.get(String(wo.stockItemId)) : null;

      const row = {
        _id: wo._id,
        shortId: shortIdOf(wo._id),
        workOrderNumber: wo.workOrderNumber || "",
        productName: wo.stockItemName || si?.name || "Unnamed product",
        productReference: wo.stockItemReference || "",
        variantLabel: variantLabelOf(wo),
        imageUrl: resolveImage(wo, si),
        workOrderStatus: wo.status || "",
        total,
        done,
        pending: pending.length,
        percent: total ? Math.round((done / total) * 100) : 0,
        nextUnit: pending[0] ?? null,
        nextBarcode: pending[0] != null ? barcodeFor(wo._id, pending[0]) : null,
        lastScan: c?.lastScan || null,
        /* PPC's published target for this work order, if it has one. One
           target covers the whole Sales line: several work orders of that
           line show the same one, and it is answered once. */
        ppcTarget: targetByWorkOrder.get(String(wo._id)) || null,
        state:
          done === 0
            ? "not_started"
            : done >= total
              ? "finished"
              : "in_progress",
      };

      const key = cr ? String(cr._id) : "unassigned";
      if (!orderMap.has(key)) {
        orderMap.set(key, {
          _id: key,
          moNumber: cr?.requestId
            ? `MO-${cr.requestId}`
            : "No manufacturing order",
          customerName: cr?.customerInfo?.name || "—",
          requestType: cr?.requestType || "",
          createdAt: cr?.createdAt || wo.createdAt,
          workOrders: [],
          total: 0,
          done: 0,
          pending: 0,
        });
      }
      const group = orderMap.get(key);
      group.workOrders.push(row);
      if (row.ppcTarget) {
        group.ppcTargets = group.ppcTargets || new Map();
        group.ppcTargets.set(row.ppcTarget.publicationId, row.ppcTarget);
      }
      group.total += row.total;
      group.done += row.done;
      group.pending += row.pending;
    }

    let orders = [...orderMap.values()].map((g) => ({
      ...g,
      /* The order's distinct targets, and how many still await an answer. */
      ppcTargets: [...(g.ppcTargets?.values() || [])],
      awaitingPpcTargetCount: [...(g.ppcTargets?.values() || [])].filter((t) => t.awaitingResponse).length,
      percent: g.total ? Math.round((g.done / g.total) * 100) : 0,
      state:
        g.done === 0
          ? "not_started"
          : g.done >= g.total
            ? "finished"
            : "in_progress",
      lastScan: g.workOrders.reduce(
        (acc, w) =>
          w.lastScan && (!acc || new Date(w.lastScan) > new Date(acc))
            ? w.lastScan
            : acc,
        null,
      ),
    }));

    if (search) {
      orders = orders
        .map((g) => {
          const groupHit = [g.moNumber, g.customerName]
            .filter(Boolean)
            .some((v) => v.toLowerCase().includes(search));
          if (groupHit) return g;
          const hits = g.workOrders.filter((w) =>
            [
              w.productName,
              w.workOrderNumber,
              w.shortId,
              w.variantLabel,
              w.productReference,
            ]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(search)),
          );
          return hits.length ? { ...g, workOrders: hits } : null;
        })
        .filter(Boolean);
    }

    // Part-way-through orders first — that's where somebody is already working.
    const rank = { in_progress: 0, not_started: 1, finished: 2 };
    orders.sort((a, b) => {
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      if (a.state === "in_progress")
        return new Date(b.lastScan || 0) - new Date(a.lastScan || 0);
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    orders.forEach((g) =>
      g.workOrders.sort(
        (a, b) => rank[a.state] - rank[b.state] || b.pending - a.pending,
      ),
    );

    res.json({
      success: true,
      /* What this signed-in person may do with a published target, decided by
         the server from their live Embroidery grant — so the screen offers
         Accept and Refuse only to somebody who may use them. The answer
         routes enforce it regardless. */
      access: { canRespond: await emb.canAnswerTargets(req) },
      orders,
      totals: {
        orders: orders.length,
        workOrders: orders.reduce((s, g) => s + g.workOrders.length, 0),
        pieces: orders.reduce((s, g) => s + g.total, 0),
        done: orders.reduce((s, g) => s + g.done, 0),
        pending: orders.reduce((s, g) => s + g.pending, 0),
      },
    });
  } catch (err) {
    console.error("[EMB queue]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /manufacturing-orders/:moId — embroidery performance scoped to one MO,
// for the Project Manager's per-MO "Embroidery" tab: WO-wise done/pending,
// operator leaderboard, and a day-wise trend across this MO's work orders.
// ═════════════════════════════════════════════════════════════════════════════
/* Shared with the project manager's Embroidery tab, so it is company-scoped
   without the Embroidery-only guard. */
router.get("/manufacturing-orders/:moId", emb.embroideryCompany, async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }

    /* Another company's order, and one whose work orders cannot prove a
       company, are answered exactly like an order that does not exist. */
    const workOrders = await WorkOrder.find({
      customerRequestId: moId,
      status: { $ne: "pending" },
      ...emb.workOrderScope(req.embroidery.companyId),
    })
      .select("workOrderNumber stockItemName stockItemReference quantity variantAttributes stockItemId")
      .lean();

    if (!workOrders.length) {
      return res.json({
        success: true,
        workOrders: [],
        totals: { total: 0, done: 0, pending: 0, percent: 0 },
        operators: [],
        trend: [],
      });
    }

    const woIds = workOrders.map((w) => w._id);
    const stockItemIds = [...new Set(workOrders.map((w) => w.stockItemId?.toString()).filter(Boolean))];
    const stockItems = stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } }).select("name images variants").lean()
      : [];
    const siMap = new Map(stockItems.map((s) => [s._id.toString(), s]));

    const records = await EmbroideryRecord.find({ workOrderId: { $in: woIds } })
      .sort({ scannedAt: -1 })
      .lean();

    const recByWo = new Map();
    for (const r of records) {
      const k = String(r.workOrderId);
      if (!recByWo.has(k)) recByWo.set(k, []);
      recByWo.get(k).push(r);
    }

    const woRows = workOrders.map((wo) => {
      const recs = recByWo.get(String(wo._id)) || [];
      const doneUnits = [...new Set(recs.map((r) => r.unitNumber))];
      const total = wo.quantity || 0;
      const done = doneUnits.length;
      const pending = Math.max(0, total - done);
      const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
      return {
        workOrderId: wo._id,
        workOrderNumber: wo.workOrderNumber,
        productName: wo.stockItemName || si?.name || "—",
        variantLabel: variantLabelOf(wo),
        image: resolveImage(wo, si),
        total,
        done,
        pending,
        percent: total ? Math.round((done / total) * 100) : 0,
        state: done === 0 ? "not_started" : done >= total ? "finished" : "in_progress",
        lastScan: recs[0]?.scannedAt || null,
      };
    });

    // Operator leaderboard across this MO
    const opMap = new Map();
    for (const r of records) {
      const k = r.operatorBiometricId;
      if (!opMap.has(k)) {
        opMap.set(k, { biometricId: k, name: r.operatorName, pieces: 0, firstScan: r.scannedAt, lastScan: r.scannedAt });
      }
      const o = opMap.get(k);
      o.pieces += 1;
      if (new Date(r.scannedAt) < new Date(o.firstScan)) o.firstScan = r.scannedAt;
      if (new Date(r.scannedAt) > new Date(o.lastScan)) o.lastScan = r.scannedAt;
    }
    const operators = [...opMap.values()].sort((a, b) => b.pieces - a.pieces);

    // Day-wise trend for this MO
    const dayMap = new Map();
    for (const r of records) dayMap.set(r.date, (dayMap.get(r.date) || 0) + 1);
    const trend = [...dayMap.entries()]
      .map(([date, pieces]) => ({ date, pieces }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totals = woRows.reduce(
      (acc, w) => {
        acc.total += w.total;
        acc.done += w.done;
        acc.pending += w.pending;
        return acc;
      },
      { total: 0, done: 0, pending: 0 }
    );
    totals.percent = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;

    res.json({ success: true, workOrders: woRows, totals, operators, trend });
  } catch (err) {
    console.error("[EMB MO overview]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
