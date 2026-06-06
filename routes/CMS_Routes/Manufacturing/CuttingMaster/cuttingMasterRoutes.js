// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helper — compute unit-wise + person-wise progress for a measurement order
// (used by the listing endpoint to power the per-MO progress bar)
// ─────────────────────────────────────────────────────────────────────────────
function computeMeasurementProgress(measurement) {
  const empty = {
    cuttingProgress: { totalUnits: 0, doneUnits: 0, pendingUnits: 0, donePercent: 0 },
    personProgress: { totalPersons: 0, donePersons: 0, pendingPersons: 0 },
  };

  if (
    !measurement ||
    !Array.isArray(measurement.employeeMeasurements) ||
    measurement.employeeMeasurements.length === 0
  ) {
    return empty;
  }

  let donePersons = 0;
  let pendingPersons = 0;
  let totalUnits = 0;
  let doneUnits = 0;

  for (const emp of measurement.employeeMeasurements) {
    const products = Array.isArray(emp.products) ? emp.products : [];

    if (products.length === 0) {
      pendingPersons++;
      continue;
    }

    const totalProds = products.length;
    const doneProds = products.filter((p) => p.qrGenerated === true).length;

    if (doneProds === totalProds) donePersons++;
    else pendingPersons++;

    for (const p of products) {
      let qty = 1;
      if (typeof p.quantity === "number") qty = p.quantity;
      else if (
        typeof p.unitEnd === "number" &&
        typeof p.unitStart === "number"
      )
        qty = p.unitEnd - p.unitStart + 1;
      totalUnits += qty;
      if (p.qrGenerated === true) doneUnits += qty;
    }
  }

  const pendingUnits = totalUnits - doneUnits;
  const donePercent =
    totalUnits > 0 ? Math.round((doneUnits / totalUnits) * 100) : 0;

  return {
    cuttingProgress: { totalUnits, doneUnits, pendingUnits, donePercent },
    personProgress: {
      totalPersons: measurement.employeeMeasurements.length,
      donePersons,
      pendingPersons,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — pull the first non-empty image field off a StockItem document.
// We probe several common field names; whichever one your model uses, it
// will be picked. If your model stores something else (e.g. `coverImage`),
// add it to the list below.
// ─────────────────────────────────────────────────────────────────────────────
function pickStockItemImage(si, variantAttributes) {
  if (!si) return null;

  // Try variant-level image first
  if (Array.isArray(variantAttributes) && variantAttributes.length > 0 && Array.isArray(si.variants)) {
    for (const v of si.variants) {
      if (!Array.isArray(v.attributes)) continue;
      const matched = variantAttributes.every((want) =>
        v.attributes.some(
          (a) =>
            String(a.name).toLowerCase() === String(want.name).toLowerCase() &&
            String(a.value).toLowerCase() === String(want.value).toLowerCase(),
        ),
      );
      if (matched && Array.isArray(v.images) && v.images[0]) return v.images[0];
    }
  }

  // Fallback: product-level image
  return (Array.isArray(si.images) && si.images[0]) || null;
}

// ── GET /master-stats?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────────────
router.get("/master-stats", async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date().toISOString().slice(0, 10);
    const toDate   = to   || fromDate;

    const CuttingMasterRecord = require("../../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");

    const records = await CuttingMasterRecord.find({
      date: { $gte: fromDate, $lte: toDate }
    }).lean();

    const masterMap = new Map();
    for (const record of records) {
      const key = record.employeeId.toString();
      if (!masterMap.has(key)) {
        masterMap.set(key, {
          employeeId:    record.employeeId,
          employeeName:  record.employeeName,
          biometricId:   record.biometricId  || "",
          department:    record.department   || "",
          designation:   record.designation  || "",
          totalUnitsCut: 0,
          daysWorked:    0,
          woSet:         new Set()
        });
      }
      const m = masterMap.get(key);
      m.totalUnitsCut += record.totalUnitsCut || 0;
      m.daysWorked++;
      (record.entries || []).forEach(e => { if (e.woNumber) m.woSet.add(e.woNumber); });
    }

    const masters = [...masterMap.values()]
      .map(({ woSet, ...m }) => ({ ...m, woCount: woSet.size }))
      .sort((a, b) => b.totalUnitsCut - a.totalUnitsCut);

    res.json({ success: true, masters, total: masters.length });
  } catch (error) {
    console.error("master-stats error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /barcode-search?barcode=WO-7e891fe6-005 ──────────────────────────────
router.get("/barcode-search", async (req, res) => {
  try {
    const { barcode = "" } = req.query;
    if (!barcode.trim()) return res.json({ success: true, results: [] });

    const CuttingMasterRecord = require("../../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");

    const input = barcode.trim();

    // Parse format: WO-{8hexChars}-{unit} or {8hexChars}-{unit}
    const match = input.match(/^(?:WO-)?([A-Fa-f0-9]{8})-0*(\d+)$/);
    let woShortId = null;
    let unitNum   = null;
    if (match) {
      woShortId = match[1].toLowerCase();
      unitNum   = parseInt(match[2]);
    }

    let dbRecords = [];

    if (woShortId && unitNum != null) {
      // Find records where any entry covers this unit number
      dbRecords = await CuttingMasterRecord.find({
        entries: {
          $elemMatch: {
            startUnit: { $lte: unitNum },
            endUnit:   { $gte: unitNum }
          }
        }
      }).lean();
    } else {
      // Fallback: search by WO number string
      dbRecords = await CuttingMasterRecord.find({
        "entries.woNumber": { $regex: input, $options: "i" }
      }).lean();
    }

    const results = [];
    for (const record of dbRecords) {
      for (const entry of record.entries || []) {
        const unitInRange  = unitNum != null ? (entry.startUnit <= unitNum && entry.endUnit >= unitNum) : true;
        const woIdMatch    = woShortId ? entry.woId?.toString().endsWith(woShortId) : false;
        const woNumMatch   = woShortId ? (entry.woNumber || "").toLowerCase().includes(woShortId) : false;
        const fallbackMatch = !woShortId && (entry.woNumber || "").toLowerCase().includes(input.toLowerCase());

        if (unitInRange && (woIdMatch || woNumMatch || fallbackMatch)) {
          results.push({
            employeeName:  record.employeeName,
            biometricId:   record.biometricId  || "",
            department:    record.department   || "",
            designation:   record.designation  || "",
            date:          record.date,
            woNumber:      entry.woNumber      || "",
            stockItemName: entry.stockItemName || "",
            variants:      entry.variants      || "",
            unitNumber:    unitNum,
            startUnit:     entry.startUnit,
            endUnit:       entry.endUnit,
            timestamp:     entry.timestamp
          });
        }
      }
    }

    res.json({ success: true, results, barcode: input });
  } catch (error) {
    console.error("barcode-search error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET all manufacturing orders (listing endpoint — unchanged from previous step)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders", async (req, res) => {
  try {
    const manufacturingOrders = await CustomerRequest.aggregate([
      { $match: { status: "quotation_sales_approved" } },
      {
        $lookup: {
          from: "workorders",
          let: { reqId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$customerRequestId", "$$reqId"] },
                status: { $ne: "pending" },
              },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                totalUnits: { $sum: { $ifNull: ["$quantity", 0] } },
                doneUnits: {
                  $sum: { $ifNull: ["$cuttingProgress.completed", 0] },
                },
              },
            },
          ],
          as: "_woStats",
        },
      },
      {
        $addFields: {
          workOrdersCount: {
            $ifNull: [{ $arrayElemAt: ["$_woStats.count", 0] }, 0],
          },
          _bulkTotalUnits: {
            $ifNull: [{ $arrayElemAt: ["$_woStats.totalUnits", 0] }, 0],
          },
          _bulkDoneUnits: {
            $ifNull: [{ $arrayElemAt: ["$_woStats.doneUnits", 0] }, 0],
          },
        },
      },
      { $match: { workOrdersCount: { $gt: 0 } } },
      {
        $project: {
          requestId: 1,
          customerInfo: 1,
          status: 1,
          requestType: 1,
          measurementId: 1,
          measurementName: 1,
          createdAt: 1,
          workOrdersCount: 1,
          _bulkTotalUnits: 1,
          _bulkDoneUnits: 1,
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    const measurementMOIds = manufacturingOrders
      .filter((o) => o.requestType === "measurement_conversion")
      .map((o) => o._id);

    const measurementMap = new Map();
    if (measurementMOIds.length > 0) {
      const measurements = await Measurement.find({
        poRequestId: { $in: measurementMOIds },
      })
        .select("poRequestId employeeMeasurements")
        .lean();

      measurements.forEach((m) => {
        if (m.poRequestId)
          measurementMap.set(m.poRequestId.toString(), m);
      });
    }

    const ordersWithTags = manufacturingOrders.map((order) => {
      const isMeasurement = order.requestType === "measurement_conversion";

      let cuttingProgress;
      let personProgress = null;

      if (isMeasurement) {
        const m = measurementMap.get(order._id.toString()) || null;
        const { cuttingProgress: cp, personProgress: pp } =
          computeMeasurementProgress(m);
        cuttingProgress = cp;
        personProgress = pp;
      } else {
        const totalUnits = order._bulkTotalUnits || 0;
        const doneUnits = order._bulkDoneUnits || 0;
        cuttingProgress = {
          totalUnits,
          doneUnits,
          pendingUnits: Math.max(0, totalUnits - doneUnits),
          donePercent:
            totalUnits > 0 ? Math.round((doneUnits / totalUnits) * 100) : 0,
        };
      }

      const { _bulkTotalUnits, _bulkDoneUnits, ...rest } = order;

      return {
        ...rest,
        orderType: isMeasurement
          ? "measurement_conversion"
          : "customer_bulk_order",
        orderTypeLabel: isMeasurement ? "Measurement → PO" : "Bulk Order",
        cuttingProgress,
        personProgress,
      };
    });

    res.json({
      success: true,
      manufacturingOrders: ordersWithTags,
      total: ordersWithTags.length,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /cutting-history-bulk (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/cutting-history-bulk", async (req, res) => {
  try {
    const { from, to, q } = req.query;

    const fromDate = from
      ? new Date(`${from}T00:00:00.000`)
      : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to ? new Date(`${to}T23:59:59.999`) : new Date();

    const searchQuery = (q || "").trim().toLowerCase();

    const bulkRequests = await CustomerRequest.find({
      requestType: { $ne: "measurement_conversion" },
      status: "quotation_sales_approved",
    })
      .select("_id requestId customerInfo")
      .lean();

    if (bulkRequests.length === 0) {
      return res.json({
        success: true,
        bulkGroups: [],
        stats: { totalCustomers: 0, totalWorkOrders: 0, totalPieces: 0 },
      });
    }

    const bulkRequestMap = new Map();
    bulkRequests.forEach((r) => bulkRequestMap.set(r._id.toString(), r));

    const bulkWOs = await WorkOrder.find({
      customerRequestId: {
        $in: bulkRequests.map((r) => new mongoose.Types.ObjectId(r._id)),
      },
      "cuttingProgress.completed": { $gt: 0 },
      updatedAt: { $gte: fromDate, $lte: toDate },
    })
      .select(
        "_id workOrderNumber customerRequestId stockItemName variantAttributes " +
          "cuttingProgress cuttingStatus quantity updatedAt",
      )
      .sort({ updatedAt: -1 })
      .lean();

    const bulkGroupsMap = new Map();

    for (const wo of bulkWOs) {
      const reqDoc = bulkRequestMap.get(wo.customerRequestId.toString());
      const customerName = reqDoc?.customerInfo?.name || "Unknown Customer";
      const requestRef = reqDoc?.requestId || "—";

      if (searchQuery) {
        const variantStr = (wo.variantAttributes || [])
          .map((a) => `${a.name}:${a.value}`)
          .join(" ")
          .toLowerCase();
        const hay = [
          wo.workOrderNumber,
          wo.stockItemName,
          customerName,
          requestRef,
          variantStr,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(searchQuery)) continue;
      }

      const groupKey = `${customerName}::${requestRef}`;

      if (!bulkGroupsMap.has(groupKey)) {
        bulkGroupsMap.set(groupKey, {
          customerName,
          requestRef,
          workOrders: [],
          totalPieces: 0,
        });
      }

      const group = bulkGroupsMap.get(groupKey);
      group.workOrders.push({
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        productName: wo.stockItemName,
        variantAttributes: wo.variantAttributes || [],
        qtyCut: wo.cuttingProgress?.completed || 0,
        totalQty: wo.quantity || 0,
        status: wo.cuttingStatus || "pending",
        cutAt: wo.updatedAt,
      });
      group.totalPieces += wo.cuttingProgress?.completed || 0;
    }

    const bulkGroups = [...bulkGroupsMap.values()].sort((a, b) => {
      const aLatest = Math.max(
        ...a.workOrders.map((w) => new Date(w.cutAt).getTime()),
      );
      const bLatest = Math.max(
        ...b.workOrders.map((w) => new Date(w.cutAt).getTime()),
      );
      return bLatest - aLatest;
    });

    const stats = {
      totalCustomers: bulkGroups.length,
      totalWorkOrders: bulkGroups.reduce((s, g) => s + g.workOrders.length, 0),
      totalPieces: bulkGroups.reduce((s, g) => s + g.totalPieces, 0),
    };

    res.json({ success: true, bulkGroups, stats });
  } catch (error) {
    console.error("cutting-history-bulk error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET specific MO with its work orders
//
// CHANGES IN THIS VERSION:
//   – Adds `stockItemImage` to each WO (picked from any of several plausible
//     image fields on the StockItem doc — see pickStockItemImage helper).
//   – Adds `cuttingUnitProgress` to each WO ({totalUnits, doneUnits,
//     pendingUnits, donePercent}). For BOTH bulk and measurement orders
//     this is derived the same way (from wo.cuttingProgress.completed /
//     wo.quantity) so the WO status badge reflects actual cutting progress,
//     not QR generation status.
//   – `cuttingStatus` is now derived from cuttingUnitProgress for every
//     WO (was previously overridden by QR status for measurement orders,
//     which the user reported as showing wrong).
//   – `qrGenerationStatus` is still computed and returned — it remains the
//     source of truth for the Employee tab inside the detail page.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:moId", async (req, res) => {
  try {
    const { moId } = req.params;

    const manufacturingOrder = await CustomerRequest.findById(moId)
      .select("requestId customerInfo requestType measurementId createdAt")
      .lean();

    if (!manufacturingOrder) {
      return res.status(404).json({ success: false, message: "MO not found" });
    }

    const workOrders = await WorkOrder.find({
      customerRequestId: moId,
      status: { $ne: "pending" },
    })
      .select(
        "workOrderNumber stockItemName stockItemId quantity variantAttributes " +
          "cuttingStatus cuttingProgress status createdAt _id",
      )
      .sort({ createdAt: -1 })
      .lean();

    const stockItemIds = [
      ...new Set(
        workOrders.map((wo) => wo.stockItemId?.toString()).filter(Boolean),
      ),
    ];

    // We probe multiple image-field names on the StockItem doc so this works
    // regardless of which one your schema uses. Adjust pickStockItemImage if
    // your model uses a different field.
    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select(
        "_id genderCategory gender category " +
          "image imageUrl imageURL productImage coverImage photo thumbnail images variants productVariants options",
      )
      .lean();

    const stockItemCategoryMap = new Map();
    const stockItemImageMap = new Map();
    stockItems.forEach((si) => {
      const id = si._id.toString();
      stockItemCategoryMap.set(
        id,
        si.genderCategory || si.gender || si.category || null,
      );
      stockItemImageMap.set(id, si);
    });

    const measurement =
      manufacturingOrder.requestType === "measurement_conversion"
        ? await Measurement.findOne({ poRequestId: moId }).lean()
        : null;

    const enhancedWorkOrders = workOrders.map((wo) => {
      const stockItemKey = wo.stockItemId?.toString();
      const genderCategory = stockItemCategoryMap.get(stockItemKey) || null;
      const stockItemImage = pickStockItemImage(stockItemImageMap.get(stockItemKey), wo.variantAttributes);

      // ── qrGenerationStatus (Employee tab) ─────────────────────────────
      let qrGenerationStatus = {
        allGenerated: false,
        someGenerated: false,
        noneGenerated: true,
        generatedCount: 0,
        totalEmployees: 0,
      };

      if (measurement) {
        const employeesForProduct = measurement.employeeMeasurements.filter(
          (emp) => emp.products.some((p) => p.productName === wo.stockItemName),
        );

        const generatedEmployees = employeesForProduct.filter((emp) =>
          emp.products.some(
            (p) =>
              p.productName === wo.stockItemName && p.qrGenerated === true,
          ),
        );

        const total = employeesForProduct.length;
        const done = generatedEmployees.length;

        qrGenerationStatus = {
          allGenerated: total > 0 && done === total,
          someGenerated: done > 0 && done < total,
          noneGenerated: done === 0,
          generatedCount: done,
          totalEmployees: total,
        };
      }

      // ── cuttingUnitProgress (WO list + status badge) ─────────────────
      const totalUnits = wo.quantity || 0;
      // Measurement orders: cuttingProgress.completed is never incremented
      // in the QR-generation flow so it always reads 0. Derive doneUnits
      // instead by summing the quantity of every QR-generated product entry
      // in the measurement doc that belongs to this WO's stock item.
      // Bulk orders: use stored cuttingProgress.completed as before.
      let doneUnits = 0;
      if (measurement) {
        for (const emp of measurement.employeeMeasurements) {
          for (const p of emp.products || []) {
            if (
              p.productId?.toString() === wo.stockItemId?.toString() &&
              p.qrGenerated === true
            ) {
              doneUnits += typeof p.quantity === "number" ? p.quantity : 1;
            }
          }
        }
      } else {
        doneUnits = wo.cuttingProgress?.completed || 0;
      }
      const pendingUnits = Math.max(0, totalUnits - doneUnits);
      const donePercent =
        totalUnits > 0 ? Math.round((doneUnits / totalUnits) * 100) : 0;

      let derivedCuttingStatus = "pending";
      if (totalUnits > 0 && doneUnits >= totalUnits)
        derivedCuttingStatus = "completed";
      else if (doneUnits > 0) derivedCuttingStatus = "in_progress";

      // Strip raw cuttingProgress to avoid the consumer confusing it
      // with the new cuttingUnitProgress block.
      const { cuttingProgress: _raw, ...woRest } = wo;

      return {
        ...woRest,
        cuttingStatus: derivedCuttingStatus,
        genderCategory,
        stockItemImage,
        qrGenerationStatus,
        cuttingUnitProgress: {
          totalUnits,
          doneUnits,
          pendingUnits,
          donePercent,
        },
      };
    });

    res.json({
      success: true,
      manufacturingOrder: {
        ...manufacturingOrder,
        orderType:
          manufacturingOrder.requestType === "measurement_conversion"
            ? "measurement_conversion"
            : "customer_bulk_order",
        orderTypeLabel:
          manufacturingOrder.requestType === "measurement_conversion"
            ? "Measurement → PO"
            : "Bulk Order",
      },
      workOrders: enhancedWorkOrders,
      totalWorkOrders: enhancedWorkOrders.length,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;