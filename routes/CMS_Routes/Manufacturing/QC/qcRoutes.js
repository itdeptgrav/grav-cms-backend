// routes/CMS_Routes/Manufacturing/QC/qcRoutes.js

const express = require("express");
const router  = express.Router();

const WorkOrder                  = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest            = require("../../../../models/Customer_Models/CustomerRequest");
const ProductionTracking         = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Employee                   = require("../../../../models/Employee");
const Operation                  = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const QCInspection               = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const EmployeeMpc                = require("../../../../models/Customer_Models/Employee_Mpc");
const Measurement                = require("../../../../models/Customer_Models/Measurement");

// ─── Helpers ──────────────────────────────────────────────────────────────────
const istDateString = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};

const parseBarcode = (raw) => {
  if (!raw || typeof raw !== "string") return { success: false };
  const parts = raw.trim().split("-");
  if (parts.length !== 3 || parts[0] !== "WO") return { success: false };
  const unit = parseInt(parts[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return { success: false };
  return { success: true, workOrderShortId: parts[1], unitNumber: unit };
};

const extractCategory = (code) => {
  if (!code) return "OTHER";
  const m = String(code).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "OTHER";
};

const findWorkOrderByShortId = async (shortId) => {
  const matches = await WorkOrder.aggregate([
    { $match: { $expr: { $eq: [{ $substrCP: [{ $toString: "$_id" }, 16, 8] }, shortId] } } },
    { $limit: 1 },
    { $project: {
      _id: 1, workOrderNumber: 1, stockItemName: 1, stockItemReference: 1,
      stockItemId: 1, quantity: 1, status: 1, variantAttributes: 1, customerRequestId: 1,
    }},
  ]);
  return matches[0] || null;
};

// ─── Master operations cache (1 min TTL) ──────────────────────────────────────
let opsCache   = null;
let opsCacheAt = 0;
const OPS_CACHE_MS = 60 * 1000;

const getMasterOperations = async () => {
  const now = Date.now();
  if (opsCache && now - opsCacheAt < OPS_CACHE_MS) return opsCache;
  opsCache   = await Operation.find({ operationCode: { $ne: "" } })
    .select("name operationCode totalSam machineType").lean();
  opsCacheAt = now;
  return opsCache;
};

router.post("/refresh-operations-cache", (_req, res) => {
  opsCache = null; opsCacheAt = 0;
  res.json({ success: true });
});

// ─── POST /signin ──────────────────────────────────────────────────────────────
router.post("/signin", async (req, res) => {
  try {
    const { biometricId } = req.body;
    if (!biometricId || !String(biometricId).trim())
      return res.status(400).json({ success: false, message: "Biometric ID is required" });

    const trimmedId = String(biometricId).trim();
    const employee  = await Employee.findOne({ biometricId: trimmedId })
      .select("firstName middleName lastName biometricId identityId department designation isActive status").lean();

    if (!employee)
      return res.status(404).json({ success: false, message: "No employee found with this ID." });

    if (employee.isActive === false || employee.status === "inactive")
      return res.status(403).json({ success: false, message: "This employee account is inactive." });

    const name = [employee.firstName, employee.middleName, employee.lastName]
      .filter(Boolean).join(" ").trim() || trimmedId;

    return res.json({
      success: true, name,
      biometricId: employee.biometricId,
      identityId:  employee.identityId  || "",
      department:  employee.department  || "",
      designation: employee.designation || "",
    });
  } catch (err) {
    console.error("[QC signin] error:", err);
    res.status(500).json({ success: false, message: "Server error during sign-in" });
  }
});

// ─── POST /lookup-piece ────────────────────────────────────────────────────────
router.post("/lookup-piece", async (req, res) => {
  try {
    const { barcode } = req.body;
    if (!barcode) return res.status(400).json({ success: false, message: "barcode is required" });

    const trimmed = barcode.trim();
    const parsed  = parseBarcode(trimmed);
    if (!parsed.success)
      return res.status(400).json({ success: false, message: "Invalid barcode format. Expected WO-<shortId>-<unit>" });

    const { workOrderShortId, unitNumber } = parsed;

    const [workOrder, trackingScans, existingInspections, masterOps] = await Promise.all([
      findWorkOrderByShortId(workOrderShortId),
      ProductionTracking.aggregate([
        { $match: { "machines.operators.barcodeScans.barcodeId": trimmed } },
        { $unwind: "$machines" },
        { $unwind: "$machines.operators" },
        { $unwind: "$machines.operators.barcodeScans" },
        { $match: { "machines.operators.barcodeScans.barcodeId": trimmed } },
        { $lookup: { from: "machines", localField: "machines.machineId", foreignField: "_id", as: "_m" } },
        { $project: {
          _id: 0,
          operatorId:  "$machines.operators.operatorIdentityId",
          activeOps:   "$machines.operators.barcodeScans.activeOps",
          timeStamp:   "$machines.operators.barcodeScans.timeStamp",
          machineName: { $arrayElemAt: ["$_m.name", 0] },
        }},
      ]),
      QCInspection.find({ barcodeId: trimmed }).sort({ inspectedAt: -1 }).limit(10).lean(),
      getMasterOperations(),
    ]);

    if (!workOrder)
      return res.status(404).json({ success: false, message: `Work order "${workOrderShortId}" not found` });
    if (unitNumber > workOrder.quantity)
      return res.status(400).json({ success: false, message: `Unit ${unitNumber} out of range (1–${workOrder.quantity})` });

    const [customerRequest, empProgress] = await Promise.all([
      workOrder.customerRequestId
        ? CustomerRequest.findById(workOrder.customerRequestId).lean()
        : Promise.resolve(null),
      EmployeeProductionProgress.findOne({
        workOrderId: workOrder._id, unitStart: { $lte: unitNumber }, unitEnd: { $gte: unitNumber },
      }).lean(),
    ]);

    const isMeasurementConversion =
      customerRequest?.requestType === "measurement_conversion" || !!empProgress?.measurementId;

    let pieceOwner = null;
    if (empProgress?.employeeName) {
      let empMpcDoc = null;
      if (empProgress.employeeId)
        empMpcDoc = await EmployeeMpc.findById(empProgress.employeeId).select("department designation").lean().catch(() => null);
      if (!empMpcDoc && empProgress.employeeUIN)
        empMpcDoc = await EmployeeMpc.findOne({ uin: empProgress.employeeUIN.trim().toUpperCase() }).select("department designation").lean().catch(() => null);

      pieceOwner = {
        employeeName: empProgress.employeeName, employeeUIN: empProgress.employeeUIN,
        gender: empProgress.gender,
        department:  empMpcDoc?.department  || "",
        designation: empMpcDoc?.designation || "",
        unitStart: empProgress.unitStart, unitEnd: empProgress.unitEnd,
        totalUnits: empProgress.totalUnits, completedUnits: empProgress.completedUnits,
        measurements: null,
      };

      const measurementIdToUse = empProgress.measurementId || customerRequest?.measurementId;
      if (measurementIdToUse) {
        try {
          const mDoc = await Measurement.findById(measurementIdToUse).select("employeeMeasurements").lean();
          if (mDoc) {
            const empEntry = (mDoc.employeeMeasurements || []).find((em) =>
              (empProgress.employeeId && em.employeeId && em.employeeId.toString() === empProgress.employeeId.toString()) ||
              (empProgress.employeeUIN && em.employeeUIN && em.employeeUIN.trim().toUpperCase() === empProgress.employeeUIN.trim().toUpperCase()) ||
              em.employeeName === empProgress.employeeName
            );
            if (empEntry) {
              const prodEntry = (empEntry.products || []).find(p => p.productId?.toString() === workOrder.stockItemId?.toString());
              if (prodEntry?.measurements?.length) pieceOwner.measurements = prodEntry.measurements;
            }
          }
        } catch (e) { console.warn("[QC lookup-piece] measurement fetch skipped:", e.message); }
      }
    }

    const operatorIds = [...new Set(trackingScans.map(s => s.operatorId).filter(Boolean))];
    const employees   = operatorIds.length
      ? await Employee.find({ identityId: { $in: operatorIds } }).select("identityId firstName middleName lastName").lean()
      : [];
    const nameMap = new Map(employees.map(e => [
      e.identityId,
      [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.identityId,
    ]));
    const getName = (id) => nameMap.get(id) || id || "Unknown";

    const opOperatorsMap = new Map();
    let totalScans = 0;
    for (const scan of trackingScans) {
      totalScans++;
      const codes = Array.isArray(scan.activeOps)
        ? scan.activeOps
        : (scan.activeOps || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const code of codes) {
        const lower = code.trim().toLowerCase();
        if (!opOperatorsMap.has(lower)) opOperatorsMap.set(lower, new Map());
        const ops = opOperatorsMap.get(lower);
        if (!ops.has(scan.operatorId)) {
          ops.set(scan.operatorId, {
            operatorId: scan.operatorId, operatorName: getName(scan.operatorId),
            machinesSet: new Set(), firstAt: scan.timeStamp, lastAt: scan.timeStamp,
          });
        }
        const entry = ops.get(scan.operatorId);
        if (scan.machineName) entry.machinesSet.add(scan.machineName);
        if (new Date(scan.timeStamp) > new Date(entry.lastAt))  entry.lastAt  = scan.timeStamp;
        if (new Date(scan.timeStamp) < new Date(entry.firstAt)) entry.firstAt = scan.timeStamp;
      }
    }

    const operations = masterOps.map(op => {
      const lower       = (op.operationCode || "").trim().toLowerCase();
      const opOperators = opOperatorsMap.get(lower);
      const operators   = opOperators
        ? Array.from(opOperators.values())
            .map(o => ({ operatorId: o.operatorId, operatorName: o.operatorName, machines: Array.from(o.machinesSet), firstAt: o.firstAt, lastAt: o.lastAt }))
            .sort((a, b) => new Date(a.firstAt) - new Date(b.firstAt))
        : [];
      return { code: op.operationCode, name: op.name, sam: op.totalSam, machineType: op.machineType, category: extractCategory(op.operationCode), operators };
    }).sort((a, b) => a.category !== b.category ? a.category.localeCompare(b.category) : a.code.localeCompare(b.code));

    const categoryCounts = {};
    operations.forEach(op => { categoryCounts[op.category] = (categoryCounts[op.category] || 0) + 1; });
    const categories = Object.entries(categoryCounts).map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code));

    const latestInspection    = existingInspections[0] || null;
    const previousDefectCodes = latestInspection?.status === "defective"
      ? (latestInspection.defects || []).map(d => d.operationCode) : [];

    return res.json({
      success: true, barcode: trimmed, unitNumber,
      workOrder: {
        _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, workOrderShortId,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity, status: workOrder.status, variantAttributes: workOrder.variantAttributes || [],
      },
      manufacturingOrder: customerRequest ? {
        _id: customerRequest._id, requestId: customerRequest.requestId,
        moNumber: `MO-${customerRequest.requestId}`, requestType: customerRequest.requestType,
        customerName: customerRequest.customerInfo?.name, customerPhone: customerRequest.customerInfo?.phone,
        status: customerRequest.status,
      } : null,
      isMeasurementConversion, pieceOwner, operations, categories,
      totalScans, totalOperations: operations.length,
      existingInspections, previousDefectCodes,
    });
  } catch (err) {
    console.error("[QC lookup-piece] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /save-inspection ─────────────────────────────────────────────────────
router.post("/save-inspection", async (req, res) => {
  try {
    const { barcodeId, workOrderShortId, workOrderId, moRequestId, manufacturingOrderId, status, defects, qcSession } = req.body;

    if (!barcodeId || !workOrderShortId || !["passed", "defective"].includes(status))
      return res.status(400).json({ success: false, message: "barcodeId, workOrderShortId and valid status are required" });

    const cleanDefects = Array.isArray(defects)
      ? defects.filter(d => d && d.operationCode).map(d => ({
          operationCode: d.operationCode, operationName: d.operationName || "",
          operators: Array.isArray(d.operators)
            ? d.operators.map(o => ({ operatorId: o.operatorId || "", operatorName: o.operatorName || "" })).filter(o => o.operatorId || o.operatorName)
            : [],
        }))
      : [];

    if (status === "defective" && cleanDefects.length === 0)
      return res.status(400).json({ success: false, message: "A defective inspection must include at least one defect operation" });

    const serverUser = req.session?.user || req.user || {};
    const qcName  = qcSession?.name        || serverUser.name || "QC";
    const qcBioId = qcSession?.biometricId || "";
    const qcId    = qcSession?.biometricId || serverUser.qcId || serverUser._id || "";

    const record = await QCInspection.create({
      date: istDateString(), barcodeId, workOrderShortId, workOrderId,
      moRequestId, manufacturingOrderId, status,
      defects: status === "defective" ? cleanDefects : [],
      inspectedByQCName: qcName, inspectedByBiometricId: qcBioId, inspectedByQCId: qcId,
    });

    res.json({ success: true, record });
  } catch (err) {
    console.error("[QC save-inspection] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /piece-operators ──────────────────────────────────────────────────────
// On-demand: given a barcode, returns every operator + machine + scan time
// from ProductionTracking. Used by the QC overview "Fetch Operator" button.
router.get("/piece-operators", async (req, res) => {
  try {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "barcode required" });

    const scans = await ProductionTracking.aggregate([
      { $match: { "machines.operators.barcodeScans.barcodeId": barcode.trim() } },
      { $unwind: "$machines" },
      { $unwind: "$machines.operators" },
      { $unwind: "$machines.operators.barcodeScans" },
      { $match: { "machines.operators.barcodeScans.barcodeId": barcode.trim() } },
      { $lookup: { from: "machines", localField: "machines.machineId", foreignField: "_id", as: "_m" } },
      { $project: {
        _id:          0,
        operatorId:   "$machines.operators.operatorIdentityId",
        operatorName: "$machines.operators.operatorName",
        activeOps:    "$machines.operators.barcodeScans.activeOps",
        timeStamp:    "$machines.operators.barcodeScans.timeStamp",
        machineName:  { $arrayElemAt: ["$_m.name", 0] },
      }},
      { $sort: { timeStamp: 1 } },
    ]);

    // Resolve names from Employee if operatorName is blank in the tracking doc
    const missingIds = [...new Set(
      scans.filter(s => !s.operatorName && s.operatorId).map(s => s.operatorId)
    )];
    let empNameMap = new Map();
    if (missingIds.length) {
      const emps = await Employee.find({ identityId: { $in: missingIds } })
        .select("identityId firstName middleName lastName").lean();
      empNameMap = new Map(emps.map(e => [
        e.identityId,
        [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.identityId,
      ]));
    }

    const operators = scans.map(s => ({
      operatorId:   s.operatorId,
      operatorName: s.operatorName || empNameMap.get(s.operatorId) || s.operatorId || "Unknown",
      activeOps:    Array.isArray(s.activeOps) ? s.activeOps : [],
      timeStamp:    s.timeStamp,
      machineName:  s.machineName || "—",
    }));

    res.json({ success: true, barcode, operators });
  } catch (err) {
    console.error("[QC piece-operators]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /trend  ───────────────────────────────────────────────────────────────
// Returns per-day DPH stats for the past N days (used by the overview trend chart)
// Must be defined BEFORE /inspections to avoid any path conflicts
router.get("/trend", async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90);

    // Build IST date strings oldest → newest
    const dates = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
      );
    }

    // Fetch only status + defects (minimal projection)
    const records = await QCInspection.find({ date: { $in: dates } })
      .select("date status defects").lean();

    // Initialise buckets for every date (so days with zero data still appear)
    const grouped = {};
    for (const date of dates)
      grouped[date] = { date, total: 0, passed: 0, defective: 0, defectOps: 0 };

    for (const r of records) {
      if (!grouped[r.date]) continue;
      grouped[r.date].total++;
      if (r.status === "passed") grouped[r.date].passed++;
      else {
        grouped[r.date].defective++;
        grouped[r.date].defectOps += (r.defects || []).length;
      }
    }

    // Build ordered trend array with DPH and a short display label (MM/DD)
    const trend = dates.map((d) => {
      const g = grouped[d];
      return {
        ...g,
        dph:         g.total > 0 ? +((g.defective / g.total) * 100).toFixed(1) : 0,
        displayDate: d.slice(5).replace("-", "/"),   // "06/27"
      };
    });

    return res.json({ success: true, trend });
  } catch (err) {
    console.error("[QC trend] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /inspections ──────────────────────────────────────────────────────────
router.get("/inspections", async (req, res) => {
  try {
    const { date, startDate, endDate, status, qcBiometricId } = req.query;
    const filter = {};

    if (date) filter.date = date;
    else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate)   filter.date.$lte = endDate;
    } else {
      filter.date = istDateString();
    }
    if (status && ["passed", "defective"].includes(status)) filter.status = status;
    if (qcBiometricId) filter.inspectedByBiometricId = qcBiometricId;

    const inspections = await QCInspection.find(filter).sort({ inspectedAt: -1 }).lean();

    const woIds = [...new Set(inspections.map(i => i.workOrderId).filter(Boolean).map(String))];
    const wos   = woIds.length
      ? await WorkOrder.find({ _id: { $in: woIds } }).select("workOrderNumber stockItemName stockItemReference variantAttributes stockItemId").lean()
      : [];
    const woMap = new Map(wos.map(w => [w._id.toString(), w]));

    const StockItem    = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
    const stockItemIds = [...new Set(wos.map(w => w.stockItemId).filter(Boolean).map(String))];
    const stockItems   = stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } }).select("name images variants").lean()
      : [];
    const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));

    const masterOps = await getMasterOperations();
    const masterMap = new Map(masterOps.map(op => [op.operationCode.trim().toLowerCase(), op.name]));

    const resolveProductImage = (wo) => {
      if (!wo) return null;
      const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
      if (!si) return null;
      if (wo.variantAttributes?.length && si.variants?.length) {
        const match = si.variants.find(v =>
          (v.attributes || []).every(va =>
            wo.variantAttributes.some(woAttr =>
              woAttr.name?.toLowerCase() === va.name?.toLowerCase() &&
              String(woAttr.value).toLowerCase() === String(va.value).toLowerCase()
            )
          )
        );
        if (match?.images?.[0]) return match.images[0];
      }
      return si.images?.[0] || null;
    };

    const enriched = inspections.map(insp => {
      const wo      = insp.workOrderId ? woMap.get(insp.workOrderId.toString()) : null;
      const defects = (insp.defects || []).map(d => ({
        ...d,
        operationName: masterMap.get((d.operationCode || "").trim().toLowerCase()) || d.operationName || "",
      }));
      return {
        ...insp, defects,
        workOrderNumber:   wo?.workOrderNumber || `WO-${insp.workOrderShortId}`,
        productName:       wo?.stockItemName   || "Unknown Product",
        productImage:      resolveProductImage(wo),
        variantAttributes: wo?.variantAttributes || [],
      };
    });

    const passed         = enriched.filter(i => i.status === "passed").length;
    const defective      = enriched.filter(i => i.status === "defective").length;
    const totalDefectOps = enriched.reduce((sum, i) => sum + (i.defects?.length || 0), 0);
    const byOperation    = {};
    const byOperator     = {};
    const byQCPerson     = {};

    enriched.forEach(i => {
      if (i.inspectedByQCName) byQCPerson[i.inspectedByQCName] = (byQCPerson[i.inspectedByQCName] || 0) + 1;
      (i.defects || []).forEach(d => {
        const opKey = d.operationName ? `${d.operationCode} — ${d.operationName}` : d.operationCode;
        byOperation[opKey] = (byOperation[opKey] || 0) + 1;
        (d.operators || []).forEach(o => {
          if (o.operatorName) byOperator[o.operatorName] = (byOperator[o.operatorName] || 0) + 1;
        });
      });
    });

    res.json({
      success: true, inspections: enriched,
      total: enriched.length, passed, defective, totalDefectOps,
      byOperation, byOperator, byQCPerson,
    });
  } catch (err) {
    console.error("[QC inspections] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;