const express = require("express");
const router = express.Router();

const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Employee = require("../../../../models/Employee");
const DefectRecord = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");

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

const findWorkOrderByShortId = async (shortId) => {
    // shortId is the last 8 chars of _id by convention used elsewhere
    const all = await WorkOrder.find({}, { _id: 1, workOrderNumber: 1, stockItemName: 1, stockItemReference: 1, quantity: 1, status: 1, variantAttributes: 1, operations: 1, customerRequestId: 1 });
    return all.find((wo) => wo._id.toString().slice(-8) === shortId) || null;
};

// ─── POST /lookup-piece  ────────────────────────────────────────────────────
// Body: { barcode }
// Returns piece info + operatorLog grouped by operator (one row per operator
// with all operations they performed on this piece).
router.post("/lookup-piece", async (req, res) => {
    try {
        const { barcode } = req.body;
        if (!barcode) return res.status(400).json({ success: false, message: "barcode is required" });

        const parsed = parseBarcode(barcode.trim());
        if (!parsed.success) {
            return res.status(400).json({ success: false, message: "Invalid barcode format. Expected WO-<shortId>-<unit>" });
        }

        const { workOrderShortId, unitNumber } = parsed;

        const workOrder = await findWorkOrderByShortId(workOrderShortId);
        if (!workOrder) {
            return res.status(404).json({ success: false, message: `Work order "${workOrderShortId}" not found` });
        }
        if (unitNumber > workOrder.quantity) {
            return res.status(400).json({ success: false, message: `Unit ${unitNumber} out of range (1–${workOrder.quantity})` });
        }

        const customerRequest = workOrder.customerRequestId
            ? await CustomerRequest.findById(workOrder.customerRequestId).lean()
            : null;
        const isMeasurementConversion = customerRequest?.requestType === "measurement_conversion";

        // ─ Piece owner (measurement-to-PO only) ─
        let pieceOwner = null;
        if (isMeasurementConversion) {
            const empProgress = await EmployeeProductionProgress.findOne({
                workOrderId: workOrder._id,
                unitStart: { $lte: unitNumber },
                unitEnd: { $gte: unitNumber },
            }).lean();
            if (empProgress) {
                pieceOwner = {
                    employeeName: empProgress.employeeName,
                    employeeUIN: empProgress.employeeUIN,
                    gender: empProgress.gender,
                    unitStart: empProgress.unitStart,
                    unitEnd: empProgress.unitEnd,
                    totalUnits: empProgress.totalUnits,
                    completedUnits: empProgress.completedUnits,
                };
            }
        }

        // ─ Operator-grouped operation log for this exact barcode ─
        const trackingDocs = await ProductionTracking.find({
            "machines.operators.barcodeScans.barcodeId": barcode.trim(),
        })
            .populate("machines.machineId", "name serialNumber type")
            .lean();

        // Map: operatorId → { name, ops Set, machines Set, lastAt }
        const operatorMap = new Map();
        let totalScans = 0;

        // Cache operator names
        const nameCache = new Map();
        const getName = async (id) => {
            if (!id) return "Unknown";
            if (nameCache.has(id)) return nameCache.get(id);
            const emp = await Employee
                .findOne({ identityId: id })
                .select("firstName middleName lastName")
                .lean();
            const fullName = emp
                ? [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim()
                : "";
            const name = fullName || id;
            nameCache.set(id, name);
            return name;
        };

        for (const doc of trackingDocs) {
            for (const machine of doc.machines || []) {
                for (const operator of machine.operators || []) {
                    const operatorId = operator.operatorIdentityId;
                    const operatorName = await getName(operatorId);
                    for (const scan of operator.barcodeScans || []) {
                        if (scan.barcodeId !== barcode.trim()) continue;
                        totalScans++;
                        const codes = Array.isArray(scan.activeOps)
                            ? scan.activeOps
                            : (scan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean);

                        if (!operatorMap.has(operatorId)) {
                            operatorMap.set(operatorId, {
                                operatorId,
                                operatorName,
                                opsSet: new Set(),
                                machinesSet: new Set(),
                                lastAt: scan.timeStamp,
                                firstAt: scan.timeStamp,
                            });
                        }
                        const entry = operatorMap.get(operatorId);
                        codes.forEach((c) => entry.opsSet.add(c));
                        if (machine.machineId?.name) entry.machinesSet.add(machine.machineId.name);
                        if (new Date(scan.timeStamp) > new Date(entry.lastAt)) entry.lastAt = scan.timeStamp;
                        if (new Date(scan.timeStamp) < new Date(entry.firstAt)) entry.firstAt = scan.timeStamp;
                    }
                }
            }
        }

        // Resolve op codes → names from WO operations
        const opLookup = new Map();
        (workOrder.operations || []).forEach((op) => {
            if (op.operationCode) opLookup.set(op.operationCode.trim().toLowerCase(), op.operationType);
        });
        const resolveOp = (code) => ({
            code,
            name: opLookup.get(code.trim().toLowerCase()) || "",
        });

        const operatorLog = Array.from(operatorMap.values())
            .map((e) => ({
                operatorId: e.operatorId,
                operatorName: e.operatorName,
                operations: Array.from(e.opsSet).map(resolveOp),
                machines: Array.from(e.machinesSet),
                firstAt: e.firstAt,
                lastAt: e.lastAt,
            }))
            .sort((a, b) => new Date(a.firstAt) - new Date(b.firstAt));

        // Already-marked-defect operators for this barcode (any date)
        const existingDefects = await DefectRecord.find({ barcodeId: barcode.trim() })
            .select("operatorId markedAt markedByQCName operations")
            .lean();

        return res.json({
            success: true,
            barcode: barcode.trim(),
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
            operatorLog,
            totalOperators: operatorLog.length,
            totalScans,
            existingDefects, // frontend can mark already-flagged operators
        });
    } catch (err) {
        console.error("[QC lookup-piece] error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── POST /mark-defect ──────────────────────────────────────────────────────
// Body: { barcodeId, workOrderShortId, workOrderId, moRequestId,
//         manufacturingOrderId, operatorId, operatorName, operations: [codes] }
router.post("/mark-defect", async (req, res) => {
    try {
        const {
            barcodeId, workOrderShortId, workOrderId,
            moRequestId, manufacturingOrderId,
            operatorId, operatorName, operations,
        } = req.body;

        if (!barcodeId || !workOrderShortId || !operatorName) {
            return res.status(400).json({ success: false, message: "barcodeId, workOrderShortId and operatorName are required" });
        }

        const qcUser = req.session?.user || req.user || {};

        const record = await DefectRecord.create({
            date: istDateString(),
            barcodeId,
            workOrderShortId,
            workOrderId,
            moRequestId,
            manufacturingOrderId,
            operatorId,
            operatorName,
            operations: Array.isArray(operations) ? operations : [],
            markedByQCName: qcUser.name || qcUser.qcId || "QC",
            markedByQCId: qcUser.qcId || qcUser._id || "",
        });

        res.json({ success: true, record });
    } catch (err) {
        console.error("[QC mark-defect] error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── GET /defects?date=YYYY-MM-DD  OR  ?startDate=&endDate= ─────────────────
// ─── GET /defects?date=YYYY-MM-DD  OR  ?startDate=&endDate= ─────────────────
router.get("/defects", async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    const filter = {};
    if (date) filter.date = date;
    else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate)   filter.date.$lte = endDate;
    } else {
      filter.date = istDateString();
    }

    const defects = await DefectRecord.find(filter).sort({ markedAt: -1 }).lean();

    // ── Resolve WOs (for op-name lookup + product info) ──────────────────────
    const woIds = [...new Set(defects.map((d) => d.workOrderId).filter(Boolean).map(String))];
    const wos = await WorkOrder.find({ _id: { $in: woIds } })
      .select("workOrderNumber operations stockItemName stockItemReference variantAttributes stockItemId")
      .lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));

    // ── Pull StockItem images for each WO's referenced product ───────────────
    const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
    const stockItemIds = [...new Set(wos.map((w) => w.stockItemId).filter(Boolean).map(String))];
    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select("name images variants genderCategory")
      .lean();
    const siMap = new Map(stockItems.map((si) => [si._id.toString(), si]));

    // ── Helper: pick the best image for a WO ─────────────────────────────────
    const resolveProductImage = (wo) => {
      if (!wo) return null;
      const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
      if (!si) return null;

      // Try matching variant first
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
      // Fallback to main StockItem image
      return si.images?.[0] || null;
    };

    const enriched = defects.map((d) => {
      const wo = d.workOrderId ? woMap.get(d.workOrderId.toString()) : null;

      const opLookup = new Map();
      (wo?.operations || []).forEach((op) => {
        if (op.operationCode) opLookup.set(op.operationCode.trim().toLowerCase(), op.operationType);
      });

      return {
        ...d,
        workOrderNumber: wo?.workOrderNumber || `WO-${d.workOrderShortId}`,
        productName:     wo?.stockItemName || "Unknown Product",
        productImage:    resolveProductImage(wo),
        variantAttributes: wo?.variantAttributes || [],
        operations: (d.operations || []).map((c) => ({
          code: c,
          name: opLookup.get(c.trim().toLowerCase()) || "",
        })),
      };
    });

    const byOperator = {};
    enriched.forEach((d) => {
      byOperator[d.operatorName] = (byOperator[d.operatorName] || 0) + 1;
    });

    res.json({
      success: true,
      defects: enriched,
      total: enriched.length,
      byOperator,
    });
  } catch (err) {
    console.error("[QC defects] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;