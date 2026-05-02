const express = require("express");
const router = express.Router();

const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Employee = require("../../../../models/Employee");
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const QCInspection = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");

// ─── Helpers ────────────────────────────────────────────────────────────────
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

// Pull the leading alphabetic chars as the category — handles S005→"S", MJ003→"MJ"
const extractCategory = (code) => {
  if (!code) return "OTHER";
  const m = String(code).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "OTHER";
};

// Short-id WO match done in MongoDB. (For best perf, add an indexed
// `workOrderShortId` field to the WorkOrder schema.)
const findWorkOrderByShortId = async (shortId) => {
  const matches = await WorkOrder.aggregate([
    { $match: { $expr: { $eq: [{ $substrCP: [{ $toString: "$_id" }, 16, 8] }, shortId] } } },
    { $limit: 1 },
    { $project: {
      _id: 1, workOrderNumber: 1, stockItemName: 1, stockItemReference: 1,
      stockItemId: 1, quantity: 1, status: 1, variantAttributes: 1,
      customerRequestId: 1,
    }},
  ]);
  return matches[0] || null;
};

// ─── Master operations cache ───────────────────────────────────────────────
let opsCache = null;
let opsCacheAt = 0;
const OPS_CACHE_MS = 60 * 1000; // 1 min

const getMasterOperations = async () => {
  const now = Date.now();
  if (opsCache && now - opsCacheAt < OPS_CACHE_MS) return opsCache;
  opsCache = await Operation.find({ operationCode: { $ne: "" } })
    .select("name operationCode totalSam machineType")
    .lean();
  opsCacheAt = now;
  return opsCache;
};

// Optional: hit this after creating/updating master ops to refresh the cache
router.post("/refresh-operations-cache", (_req, res) => {
  opsCache = null;
  opsCacheAt = 0;
  res.json({ success: true });
});

// ─── POST /lookup-piece ─────────────────────────────────────────────────────
router.post("/lookup-piece", async (req, res) => {
  try {
    const { barcode } = req.body;
    if (!barcode) return res.status(400).json({ success: false, message: "barcode is required" });

    const trimmed = barcode.trim();
    const parsed = parseBarcode(trimmed);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid barcode format. Expected WO-<shortId>-<unit>" });
    }

    const { workOrderShortId, unitNumber } = parsed;

    // Run all heavy queries in parallel
    const [workOrder, trackingScans, existingInspections, masterOps] = await Promise.all([
      findWorkOrderByShortId(workOrderShortId),
      ProductionTracking.aggregate([
        { $match: { "machines.operators.barcodeScans.barcodeId": trimmed } },
        { $unwind: "$machines" },
        { $unwind: "$machines.operators" },
        { $unwind: "$machines.operators.barcodeScans" },
        { $match: { "machines.operators.barcodeScans.barcodeId": trimmed } },
        { $lookup: {
            from: "machines",
            localField: "machines.machineId",
            foreignField: "_id",
            as: "_m",
        }},
        { $project: {
            _id: 0,
            operatorId:  "$machines.operators.operatorIdentityId",
            activeOps:   "$machines.operators.barcodeScans.activeOps",
            timeStamp:   "$machines.operators.barcodeScans.timeStamp",
            machineName: { $arrayElemAt: ["$_m.name", 0] },
        }},
      ]),
      QCInspection.find({ barcodeId: trimmed })
        .sort({ inspectedAt: -1 })
        .limit(10)
        .lean(),
      getMasterOperations(),
    ]);

    if (!workOrder) {
      return res.status(404).json({ success: false, message: `Work order "${workOrderShortId}" not found` });
    }
    if (unitNumber > workOrder.quantity) {
      return res.status(400).json({ success: false, message: `Unit ${unitNumber} out of range (1–${workOrder.quantity})` });
    }

    const [customerRequest, empProgress] = await Promise.all([
      workOrder.customerRequestId
        ? CustomerRequest.findById(workOrder.customerRequestId).lean()
        : Promise.resolve(null),
      EmployeeProductionProgress.findOne({
        workOrderId: workOrder._id,
        unitStart: { $lte: unitNumber },
        unitEnd:   { $gte: unitNumber },
      }).lean(),
    ]);
    const isMeasurementConversion = customerRequest?.requestType === "measurement_conversion";

    let pieceOwner = null;
    if (isMeasurementConversion && empProgress) {
      pieceOwner = {
        employeeName: empProgress.employeeName,
        employeeUIN:  empProgress.employeeUIN,
        gender:       empProgress.gender,
        unitStart:    empProgress.unitStart,
        unitEnd:      empProgress.unitEnd,
        totalUnits:   empProgress.totalUnits,
        completedUnits: empProgress.completedUnits,
      };
    }

    // Batch-resolve operator names (single $in query)
    const operatorIds = [...new Set(trackingScans.map((s) => s.operatorId).filter(Boolean))];
    const employees = operatorIds.length
      ? await Employee.find({ identityId: { $in: operatorIds } })
          .select("identityId firstName middleName lastName")
          .lean()
      : [];
    const nameMap = new Map(employees.map((e) => [
      e.identityId,
      [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.identityId,
    ]));
    const getName = (id) => nameMap.get(id) || id || "Unknown";

    // Build operationCode → operators map from scans for THIS piece
    const opOperatorsMap = new Map(); // lowerCode → Map<operatorId, info>
    let totalScans = 0;
    for (const scan of trackingScans) {
      totalScans++;
      const codes = Array.isArray(scan.activeOps)
        ? scan.activeOps
        : (scan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean);

      for (const code of codes) {
        const lower = code.trim().toLowerCase();
        if (!opOperatorsMap.has(lower)) opOperatorsMap.set(lower, new Map());
        const operators = opOperatorsMap.get(lower);

        if (!operators.has(scan.operatorId)) {
          operators.set(scan.operatorId, {
            operatorId:   scan.operatorId,
            operatorName: getName(scan.operatorId),
            machinesSet:  new Set(),
            firstAt: scan.timeStamp,
            lastAt:  scan.timeStamp,
          });
        }
        const entry = operators.get(scan.operatorId);
        if (scan.machineName) entry.machinesSet.add(scan.machineName);
        if (new Date(scan.timeStamp) > new Date(entry.lastAt))  entry.lastAt  = scan.timeStamp;
        if (new Date(scan.timeStamp) < new Date(entry.firstAt)) entry.firstAt = scan.timeStamp;
      }
    }

    // ─── Operations list = MASTER, with scan operators attached if any ────
    const operations = masterOps
      .map((op) => {
        const lower = (op.operationCode || "").trim().toLowerCase();
        const opOperators = opOperatorsMap.get(lower);
        const operators = opOperators
          ? Array.from(opOperators.values()).map((o) => ({
              operatorId:   o.operatorId,
              operatorName: o.operatorName,
              machines:     Array.from(o.machinesSet),
              firstAt:      o.firstAt,
              lastAt:       o.lastAt,
            })).sort((a, b) => new Date(a.firstAt) - new Date(b.firstAt))
          : [];
        return {
          code:        op.operationCode,
          name:        op.name,
          sam:         op.totalSam,
          machineType: op.machineType,
          category:    extractCategory(op.operationCode),
          operators,
        };
      })
      .sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.code.localeCompare(b.code);
      });

    // Category buckets (for the filter UI)
    const categoryCounts = {};
    operations.forEach((op) => {
      categoryCounts[op.category] = (categoryCounts[op.category] || 0) + 1;
    });
    const categories = Object.entries(categoryCounts)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const latestInspection = existingInspections[0] || null;
    const previousDefectCodes = latestInspection?.status === "defective"
      ? (latestInspection.defects || []).map((d) => d.operationCode)
      : [];

    return res.json({
      success: true,
      barcode: trimmed,
      unitNumber,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        workOrderShortId,
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity,
        status: workOrder.status,
        variantAttributes: workOrder.variantAttributes || [],
      },
      manufacturingOrder: customerRequest ? {
        _id: customerRequest._id,
        requestId: customerRequest.requestId,
        moNumber: `MO-${customerRequest.requestId}`,
        requestType: customerRequest.requestType,
        customerName: customerRequest.customerInfo?.name,
        customerPhone: customerRequest.customerInfo?.phone,
        status: customerRequest.status,
      } : null,
      isMeasurementConversion,
      pieceOwner,
      operations,
      categories,
      totalScans,
      totalOperations: operations.length,
      existingInspections,
      previousDefectCodes,
    });
  } catch (err) {
    console.error("[QC lookup-piece] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /save-inspection ──────────────────────────────────────────────────
router.post("/save-inspection", async (req, res) => {
  try {
    const {
      barcodeId, workOrderShortId, workOrderId,
      moRequestId, manufacturingOrderId,
      status, defects,
    } = req.body;

    if (!barcodeId || !workOrderShortId || !["passed", "defective"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "barcodeId, workOrderShortId and valid status (passed|defective) are required",
      });
    }

    const cleanDefects = Array.isArray(defects)
      ? defects
          .filter((d) => d && d.operationCode)
          .map((d) => ({
            operationCode: d.operationCode,
            operationName: d.operationName || "",
            operators: Array.isArray(d.operators)
              ? d.operators
                  .map((o) => ({
                    operatorId:   o.operatorId   || "",
                    operatorName: o.operatorName || "",
                  }))
                  .filter((o) => o.operatorId || o.operatorName)
              : [],
          }))
      : [];

    if (status === "defective" && cleanDefects.length === 0) {
      return res.status(400).json({
        success: false,
        message: "A defective inspection must include at least one defect operation",
      });
    }

    const qcUser = req.session?.user || req.user || {};

    const record = await QCInspection.create({
      date: istDateString(),
      barcodeId,
      workOrderShortId,
      workOrderId,
      moRequestId,
      manufacturingOrderId,
      status,
      defects: status === "defective" ? cleanDefects : [],
      inspectedByQCName: qcUser.name || qcUser.qcId || "QC",
      inspectedByQCId:   qcUser.qcId || qcUser._id || "",
    });

    res.json({ success: true, record });
  } catch (err) {
    console.error("[QC save-inspection] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /inspections?date=YYYY-MM-DD  OR  ?startDate=&endDate= ─────────────
router.get("/inspections", async (req, res) => {
  try {
    const { date, startDate, endDate, status } = req.query;
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

    const inspections = await QCInspection.find(filter).sort({ inspectedAt: -1 }).lean();

    const woIds = [...new Set(inspections.map((i) => i.workOrderId).filter(Boolean).map(String))];
    const wos = woIds.length
      ? await WorkOrder.find({ _id: { $in: woIds } })
          .select("workOrderNumber stockItemName stockItemReference variantAttributes stockItemId")
          .lean()
      : [];
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));

    const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
    const stockItemIds = [...new Set(wos.map((w) => w.stockItemId).filter(Boolean).map(String))];
    const stockItems = stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } })
          .select("name images variants")
          .lean()
      : [];
    const siMap = new Map(stockItems.map((si) => [si._id.toString(), si]));

    // For op-name resolution we now use the master operations, not the WO
    const masterOps = await getMasterOperations();
    const masterMap = new Map(
      masterOps.map((op) => [op.operationCode.trim().toLowerCase(), op.name])
    );

    const resolveProductImage = (wo) => {
      if (!wo) return null;
      const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
      if (!si) return null;
      if (wo.variantAttributes?.length && si.variants?.length) {
        const match = si.variants.find((v) =>
          (v.attributes || []).every((va) =>
            wo.variantAttributes.some(
              (woAttr) =>
                woAttr.name?.toLowerCase() === va.name?.toLowerCase() &&
                String(woAttr.value).toLowerCase() === String(va.value).toLowerCase()
            )
          )
        );
        if (match?.images?.[0]) return match.images[0];
      }
      return si.images?.[0] || null;
    };

    const enriched = inspections.map((insp) => {
      const wo = insp.workOrderId ? woMap.get(insp.workOrderId.toString()) : null;
      const defects = (insp.defects || []).map((d) => ({
        ...d,
        operationName:
          masterMap.get((d.operationCode || "").trim().toLowerCase()) ||
          d.operationName || "",
      }));

      return {
        ...insp,
        defects,
        workOrderNumber:   wo?.workOrderNumber || `WO-${insp.workOrderShortId}`,
        productName:       wo?.stockItemName || "Unknown Product",
        productImage:      resolveProductImage(wo),
        variantAttributes: wo?.variantAttributes || [],
      };
    });

    const passed    = enriched.filter((i) => i.status === "passed").length;
    const defective = enriched.filter((i) => i.status === "defective").length;
    const totalDefectOps = enriched.reduce((sum, i) => sum + (i.defects?.length || 0), 0);

    const byOperation = {};
    const byOperator  = {};
    enriched.forEach((i) => {
      (i.defects || []).forEach((d) => {
        const opKey = d.operationName ? `${d.operationCode} — ${d.operationName}` : d.operationCode;
        byOperation[opKey] = (byOperation[opKey] || 0) + 1;
        (d.operators || []).forEach((o) => {
          if (o.operatorName) byOperator[o.operatorName] = (byOperator[o.operatorName] || 0) + 1;
        });
      });
    });

    res.json({
      success: true,
      inspections: enriched,
      total: enriched.length,
      passed,
      defective,
      totalDefectOps,
      byOperation,
      byOperator,
    });
  } catch (err) {
    console.error("[QC inspections] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;