// routes/CMS_Routes/Sales/quotationRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerEmailService = require('../../../services/CustomerEmailService');
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Measurement = require("../../../models/Customer_Models/Measurement");
const EmployeeProductionProgress = require("../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const mongoose = require("mongoose");
const EmployeeMpc = require("../../../models/Customer_Models/Employee_Mpc");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const StockIssuance = require("../../../models/CMS_Models/Inventory/Operations/StockIssuance");
const MeasurementSizeConfig = require("../../../models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig");

router.use(EmployeeAuthMiddleware);

// ─── GST RULE ─────────────────────────────────────────────────────────────────
// Convert qty between units using unitConversions [{fromUnit, toUnit, quantity}]
// where quantity means: 1 fromUnit = quantity toUnit
function convertBetweenUnits(qty, fromUnit, toUnit, conversions = []) {
  if (!fromUnit || !toUnit || fromUnit === toUnit || !qty || !conversions.length) return null;
  const direct = conversions.find(c => c.fromUnit === fromUnit && c.toUnit === toUnit);
  if (direct?.quantity) return qty * direct.quantity;
  const inverse = conversions.find(c => c.fromUnit === toUnit && c.toUnit === fromUnit);
  if (inverse?.quantity) return qty / inverse.quantity;
  return null;
}

const getGSTPercentage = (unitPrice) => {
  const price = parseFloat(unitPrice) || 0;
  return price < 2499 ? 5 : 18;
};

// ─── QUOTATION ↔ REQUEST STATUS MACHINE ───────────────────────────────────────
// request.quotations[0] is the CURRENT quotation. Superseded rounds live in
// request.quotationRevisions (see POST .../quotation/revise). Its status
// is the single source of truth; request.status is a projection of it. Every
// place that touches either one must go through the helpers below, otherwise a
// plain re-save of the quotation silently drops the request back to
// "quotation_draft" and the customer's Approve button disappears — which is the
// bug that made the order appear to bounce back to the start of the pipeline.

// Rank of quotation.status. Higher = further along. Used to reject regressions.
const QUOTATION_RANK = {
  draft: 0,
  sent_to_customer: 1,
  customer_approved: 2,
  sales_approved: 3,
};

// quotation.status → request.status
const REQUEST_STATUS_FOR_QUOTATION = {
  draft: "quotation_draft",
  sent_to_customer: "quotation_sent",
  customer_approved: "quotation_customer_approved",
  sales_approved: "quotation_sales_approved",
};

// Once the order is on the shop floor its request.status is owned by production,
// not by the quotation — never rewrite it from here.
const POST_QUOTATION_STATUSES = [
  "production", "shipping", "delivered", "completed", "cancelled",
];

// Project quotation.status onto request.status. `rejected` / `expired` have no
// forward projection: the request falls back to in_progress so sales can
// re-issue, unless production already owns the request.
function syncRequestStatusFromQuotation(request, quotation) {
  if (POST_QUOTATION_STATUSES.includes(request.status)) return request.status;

  if (quotation.status === "rejected" || quotation.status === "expired") {
    request.status = "in_progress";
  } else {
    const mapped = REQUEST_STATUS_FOR_QUOTATION[quotation.status];
    if (mapped) request.status = mapped;
  }
  return request.status;
}

// True when moving from `from` to `to` would walk the quotation backwards.
// draft → sent_to_customer → customer_approved → sales_approved is one-way;
// only an explicit reject/expire may leave that ladder.
function isQuotationRegression(from, to) {
  if (!from || !to || from === to) return false;
  if (to === "rejected" || to === "expired") return false;
  if (from === "rejected" || from === "expired") return false; // re-issuing is fine
  const a = QUOTATION_RANK[from], b = QUOTATION_RANK[to];
  if (a == null || b == null) return false;
  return b < a;
}

// The quotation popup posts the whole quotation back on every save, including a
// paymentSchedule rebuilt from percentages — which has no paidAmount/status/
// receipts on it. Carry the money state over from the stored steps so saving a
// quotation can never erase a recorded payment.
function preservePaymentState(existingSchedule = [], incomingSchedule = []) {
  // A save that carries no schedule at all must not erase the stored one.
  if (!incomingSchedule.length) return existingSchedule;
  const byStep = new Map(
    existingSchedule.map(s => [s.stepNumber, s.toObject ? s.toObject() : s]),
  );
  return incomingSchedule.map(step => {
    const prev = byStep.get(step.stepNumber);
    if (!prev) return step;
    return {
      ...step,
      paidAmount:      prev.paidAmount ?? 0,
      paidDate:        prev.paidDate ?? null,
      status:          prev.status || step.status || "pending",
      paymentMethod:   step.paymentMethod || prev.paymentMethod,
      transactionId:   step.transactionId || prev.transactionId,
      paymentReceipts: prev.paymentReceipts || [],
    };
  });
}

const calculateItemTotals = (quantity, unitPrice, gstPercentage) => {
  const qty = parseFloat(quantity) || 0;
  const price = parseFloat(unitPrice) || 0;
  const gst = parseFloat(gstPercentage) || 0;
  const priceBeforeGST = qty * price;
  const gstAmount = priceBeforeGST * (gst / 100);
  const priceIncludingGST = priceBeforeGST + gstAmount;
  return {
    priceBeforeGST: parseFloat(priceBeforeGST.toFixed(2)),
    gstAmount: parseFloat(gstAmount.toFixed(2)),
    priceIncludingGST: parseFloat(priceIncludingGST.toFixed(2))
  };
};



router.post("/requests/:requestId/start-processing", async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await CustomerRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ success: false, message: "Customer request not found" });
    }
 
    // Idempotent — if already started, just return current state
    if (request.processingStartedAt) {
      return res.json({
        success: true,
        message: "Processing already started",
        request,
      });
    }
 
    request.processingStartedAt = new Date();
    if (req.user?.id) request.processingStartedBy = req.user.id;
    await request.save();
 
    return res.json({
      success: true,
      message: "Processing started",
      request,
    });
  } catch (err) {
    console.error("Start processing error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


router.patch("/work-orders/:id/assigned-deadline", async (req, res) => {
  try {
    const { id } = req.params;
    const { deadline } = req.body;
 
    const wo = await WorkOrder.findById(id);
    if (!wo) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }
 
    if (deadline === null || deadline === "") {
      wo.assignedDeadline = null;
      wo.assignedDeadlineMeta = { assignedAt: null, assignedBy: null };
    } else {
      const parsed = new Date(deadline);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid deadline date" });
      }
      wo.assignedDeadline = parsed;
      wo.assignedDeadlineMeta = {
        assignedAt: new Date(),
        assignedBy: req.user?.id || null,
      };
    }
 
    await wo.save();
    return res.json({
      success: true,
      message: deadline ? "Deadline assigned" : "Deadline cleared",
      workOrder: wo,
    });
  } catch (err) {
    console.error("Assign deadline error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ── Measurement-PO variant resolution ───────────────────────────────────────
// For a bulk order, item.variants[] already carries the real size the
// customer ordered, so BOM lookup is exact. For a measurement-conversion
// order, convert-to-po (routes/CMS_Routes/Measurement/measurementRoutes.js)
// never knows each person's real size at that point — it just groups every
// person onto whichever variant they already had, defaulting to
// stockItem.variants[0] ("any random/common variant") when unset. That means
// raw-item requirements computed straight off request.items are computed
// against the WRONG size for anyone who got the placeholder variant.
//
// This resolves the CORRECT variant per person by running their actual
// measurement value (e.g. Chest: 40) through the Settings-configured
// MeasurementSizeConfig for that product, then re-aggregates quantities by
// resolved variant — i.e. it reconstructs a request.items[]-shaped structure
// the same way a bulk order would already have it, so every existing
// BOM/shortfall/committed-stock calculation below runs unchanged on top of it.
async function resolveMeasurementRequestItems(request) {
  const measurement = await Measurement.findById(request.measurementId)
    .populate({
      path: "employeeMeasurements.products.productId",
      select: "name reference variants baseSalesPrice",
    })
    .lean();
  if (!measurement || !measurement.employeeMeasurements?.length) {
    return { items: null, unresolved: [] };
  }

  const productIds = new Set();
  measurement.employeeMeasurements.forEach((emp) =>
    (emp.products || []).forEach((p) => {
      const pid = p.productId?._id?.toString() || p.productId?.toString();
      if (pid) productIds.add(pid);
    }),
  );

  const configs = productIds.size
    ? await MeasurementSizeConfig.find({
        productId: { $in: [...productIds] },
        isActive: true,
      }).lean()
    : [];
  const configsByProduct = new Map();
  configs.forEach((c) => {
    const pid = c.productId.toString();
    if (!configsByProduct.has(pid)) configsByProduct.set(pid, []);
    configsByProduct.get(pid).push(c);
  });

  const productMap = new Map(); // `${stockItemId}_${variantId}` -> aggregated row
  const unresolved = []; // people whose size fell back to the placeholder variant
  // `${employeeId}_${stockItemId}` -> resolved StockItem variant _id string.
  // Lets WO creation assign each employee to the WO matching their OWN
  // resolved size, instead of guessing off the stale variantId that was on
  // the Measurement doc from conversion time.
  const employeeVariantMap = new Map();

  for (const emp of measurement.employeeMeasurements) {
    for (const measuredProduct of emp.products || []) {
      const si = measuredProduct.productId;
      if (!si || !si._id) continue;
      const pid = si._id.toString();

      // 1) Try every size config configured for this product until one of
      //    them has a real measured value that falls inside a rule's range.
      let resolvedVariant = null;
      const candidateConfigs = configsByProduct.get(pid) || [];
      for (const cfg of candidateConfigs) {
        const measField = (measuredProduct.measurements || []).find(
          (m) =>
            m.measurementName?.trim().toLowerCase() ===
            cfg.measurementParameter?.trim().toLowerCase(),
        );
        const val = parseFloat(measField?.value);
        if (measField?.value === undefined || measField.value === "" || Number.isNaN(val))
          continue;
        const rule = (cfg.rules || []).find((r) => val >= r.fromValue && val < r.toValue);
        if (!rule) continue;

        if (rule.variantId) {
          resolvedVariant = (si.variants || []).find(
            (v) => v._id.toString() === rule.variantId.toString(),
          );
        }
        if (!resolvedVariant) {
          const normSize = String(rule.sizeValue || "").trim().toLowerCase();
          resolvedVariant = (si.variants || []).find((v) =>
            (v.attributes || []).some(
              (a) => String(a.value || "").trim().toLowerCase() === normSize,
            ),
          );
        }
        if (resolvedVariant) break;
      }

      // 2) No config / no matching rule / resolved variant not found on the
      //    product anymore — fall back to whatever convert-to-po already
      //    assigned (mirrors its own needsAutoAssign → variants[0] logic),
      //    and flag it so the store side can see this one wasn't confirmed.
      let dv = resolvedVariant;
      let flaggedUnresolved = false;
      if (!dv) {
        flaggedUnresolved = true;
        const fallbackVariantId = measuredProduct.variantId;
        const needsAutoAssign =
          !fallbackVariantId ||
          ["null", "undefined", ""].includes(String(fallbackVariantId).trim());
        dv = needsAutoAssign
          ? si.variants?.[0] || null
          : (si.variants || []).find(
              (v) => v._id.toString() === fallbackVariantId.toString(),
            ) || si.variants?.[0] || null;
      }

      const variantAttributes =
        dv?.attributes?.map((a) => ({ name: a.name || "Attribute", value: a.value })) || [];
      const variantId = dv?._id?.toString() || "default";
      const quantity = measuredProduct.quantity || 1;
      const key = `${pid}_${variantId}`;

      employeeVariantMap.set(`${emp.employeeId?.toString()}_${pid}`, variantId);

      if (!productMap.has(key)) {
        productMap.set(key, {
          stockItemId: si._id,
          stockItemName: si.name,
          stockItemReference: si.reference || "",
          variantId,
          variantAttributes,
          totalQuantity: 0,
        });
      }
      productMap.get(key).totalQuantity += quantity;

      if (flaggedUnresolved) {
        unresolved.push({
          employeeName: emp.employeeName,
          employeeUIN: emp.employeeUIN,
          productName: si.name,
          reason: candidateConfigs.length
            ? "Measurement value didn't match any configured size range"
            : "No size configuration found for this product",
        });
      }
    }
  }

  const items = Array.from(productMap.values()).map((p) => ({
    stockItemId: p.stockItemId,
    stockItemName: p.stockItemName,
    stockItemReference: p.stockItemReference,
    variants: [
      {
        variantId: p.variantId !== "default" ? p.variantId : undefined,
        attributes: p.variantAttributes,
        quantity: p.totalQuantity,
      },
    ],
    totalQuantity: p.totalQuantity,
  }));

  return { items, unresolved, employeeVariantMap };
}

router.get("/requests/:requestId/raw-item-requirement", async (req, res) => {
  try {
    const { requestId } = req.params;
 
    const request = await CustomerRequest.findById(requestId).lean();
    if (!request) {
      return res.status(404).json({ success: false, message: "Customer request not found" });
    }

    // Measurement-PO orders: re-derive items[] via the size config so BOM
    // lookup runs against each person's actual resolved size instead of the
    // common/placeholder variant convert-to-po fell back to. Everything below
    // this point stays untouched — it just consumes whatever request.items is.
    let sizeResolution = null;
    if (
      (request.requestType === "measurement_conversion" || request.measurementId) &&
      request.measurementId
    ) {
      try {
        const resolved = await resolveMeasurementRequestItems(request);
        if (resolved.items?.length) {
          request.items = resolved.items;
          sizeResolution = {
            usedSizeConfig: true,
            unresolvedCount: resolved.unresolved.length,
            unresolved: resolved.unresolved,
          };
        }
      } catch (resolveErr) {
        console.error("Measurement size-config resolution (non-fatal):", resolveErr.message);
      }
    }

    if (!Array.isArray(request.items) || request.items.length === 0) {
      return res.json({
        success: true,
        perProduct: [],
        totals: [],
        grand: { totalLineItems: 0, totalRequired: 0, totalAvailable: 0, shortfallCount: 0 },
      });
    }
 
    // ── Fetch all StockItems referenced by the request in one go ───────────
    const stockItemIds = [
      ...new Set(
        request.items
          .map((it) => it.stockItemId)
          .filter(Boolean)
          .map((id) => (typeof id === "object" ? id.toString() : id.toString()))
      ),
    ];
    const stockItems = await StockItem.find({
      _id: { $in: stockItemIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();
    const stockItemMap = new Map(stockItems.map((s) => [s._id.toString(), s]));
 
    // ── Helper: find a matching StockItem variant for a request variant ────
    const findStockVariant = (stockItem, reqVariant) => {
      if (!stockItem.variants || stockItem.variants.length === 0) return null;
 
      // 1) Try matching by attribute set
      const reqAttrs = reqVariant.attributes || [];
      if (reqAttrs.length > 0) {
        const norm = (s) => String(s || "").trim().toLowerCase();
        for (const v of stockItem.variants) {
          const vAttrs = v.attributes || [];
          if (vAttrs.length !== reqAttrs.length) continue;
          const allMatch = reqAttrs.every((ra) =>
            vAttrs.some((va) => norm(va.name) === norm(ra.name) && norm(va.value) === norm(ra.value))
          );
          if (allMatch) return v;
        }
      }
 
      // 2) Fall back to first variant
      return stockItem.variants[0];
    };
 
    // ── Per-product list + aggregated totals ──────────────────────────────
    const perProduct = [];
    const totalsMap = new Map(); // key: `${rawItemId}|${variantId||""}`
 
    for (const item of request.items) {
      const sid = item.stockItemId?.toString();
      const stockItem = sid ? stockItemMap.get(sid) : null;
      if (!stockItem) {
        perProduct.push({
          productName: item.stockItemName || "Unknown",
          stockItemReference: item.stockItemReference || "",
          totalQuantity: item.totalQuantity || 0,
          rawItems: [],
          note: "Stock item not found in inventory",
        });
        continue;
      }
 
     const productRawItems = []; // accumulated for this product
      const variantBreakdowns = []; // per-variant detail for expanded frontend view
 
      for (const reqVariant of item.variants || []) {
        const qtyOrdered = reqVariant.quantity || 0;
        if (qtyOrdered <= 0) continue;
 
        const matchedVariant = findStockVariant(stockItem, reqVariant);
        if (!matchedVariant || !Array.isArray(matchedVariant.rawItems)) continue;

        const variantLabel = (reqVariant.attributes || []).map(a => a.value).join(" / ") || "Default";
        const variantRawItemsForBreakdown = [];
 
        for (const ri of matchedVariant.rawItems) {
          const required = (ri.quantity || 0) * qtyOrdered;
          if (required <= 0) continue;
 
          const rawItemIdStr = ri.rawItemId?.toString() || "";
          const variantIdStr = ri.variantId?.toString() || "";
          const key = `${rawItemIdStr}|${variantIdStr}`;
 
          // Accumulate for this product
          const existingForProduct = productRawItems.find(
            (p) => `${p.rawItemId}|${p.variantId || ""}` === key
          );
          // Pre-allowance required qty, scaled the same way as `required` —
          // lets the frontend show "X required + Y% allowance = Z" instead of
          // only the post-allowance quantity.
          const requiredBeforeAllowance = (ri.requiredQuantity ?? ri.quantity ?? 0) * qtyOrdered;

          if (existingForProduct) {
            existingForProduct.quantityRequired += required;
            existingForProduct.requiredQuantity += requiredBeforeAllowance;
            existingForProduct.totalCost += (ri.totalCost || 0) * (qtyOrdered / 1); // already qty-multiplied above; safer to just sum unitCost*req
          } else {
            productRawItems.push({
              rawItemId: rawItemIdStr,
              variantId: variantIdStr,
              rawItemName: ri.rawItemName,
              rawItemSku: ri.rawItemSku || "",
              variantCombination: ri.variantCombination || [],
              unit: ri.unit,
              baseUnit: ri.baseUnit || ri.unit,
              perPieceQty: ri.quantity || 0,
              quantityRequired: required,
              requiredQuantity: requiredBeforeAllowance,
              unitCost: ri.unitCost || 0,
              totalCost: (ri.unitCost || 0) * required,
            });
          }

          // Accumulate global totals
          if (!totalsMap.has(key)) {
            totalsMap.set(key, {
              rawItemId: rawItemIdStr,
              variantId: variantIdStr,
              rawItemName: ri.rawItemName,
              rawItemSku: ri.rawItemSku || "",
              variantCombination: ri.variantCombination || [],
              unit: ri.unit,
              baseUnit: ri.baseUnit || ri.unit,
              quantityRequired: 0,
              requiredQuantity: 0,
              unitCost: ri.unitCost || 0,
              totalCost: 0,
            });
          }
          const totalEntry = totalsMap.get(key);
          totalEntry.quantityRequired += required;
          totalEntry.requiredQuantity += requiredBeforeAllowance;
          totalEntry.totalCost += (ri.unitCost || 0) * required;

          variantRawItemsForBreakdown.push({
            rawItemId:     rawItemIdStr,
            variantId:     variantIdStr,
            rawItemName:   ri.rawItemName,
            perPieceQty:   ri.quantity || 0,
            perPieceRequiredQty: ri.requiredQuantity ?? ri.quantity ?? 0,
            allowancePercent: ri.allowancePercent || 0,
            quantityRequired: required,
            requiredQuantity: requiredBeforeAllowance,
            unit:          ri.unit,
          });
        }

        if (variantRawItemsForBreakdown.length > 0) {
          variantBreakdowns.push({
            variantLabel,
            quantity: qtyOrdered,
            rawItems: variantRawItemsForBreakdown,
          });
        }
      }
 
      // Pick best available image — variant-first, then product-level
      const productImage = (() => {
        if (stockItem?.variants?.length) {
          const withImg = stockItem.variants.find(v => v.images?.length > 0)
          if (withImg) return withImg.images[0]
        }
        return stockItem?.images?.[0] || null
      })()

      perProduct.push({
        productName: item.mpcDisplayName || item.stockItemName,
        stockItemReference: item.stockItemReference || "",
        totalQuantity: item.totalQuantity || 0,
        rawItems: productRawItems,
        variantBreakdowns,
        image: productImage,
      });
    }
 
    // ── Fetch current stock for all unique raw-item ids ───────────────────
    const uniqueRawItemIds = [
      ...new Set([...totalsMap.values()].map((t) => t.rawItemId).filter(Boolean)),
    ];
 
    const rawItemDocs = uniqueRawItemIds.length
      ? await RawItem.find({
          _id: { $in: uniqueRawItemIds.map((id) => new mongoose.Types.ObjectId(id)) },
        }).lean()
      : [];
    const rawItemMap = new Map(rawItemDocs.map((r) => [r._id.toString(), r]));
 
    // ── Build totals[] with availability comparison ───────────────────────
    const totals = [];
    let totalRequired = 0;
    let totalAvailable = 0;
    let shortfallCount = 0;
 
    for (const t of totalsMap.values()) {
      const doc = rawItemMap.get(t.rawItemId);
      let available = null;
      let minStock = 0;
 
      if (doc) {
        if (t.variantId && Array.isArray(doc.variants)) {
          const v = doc.variants.find((vv) => vv._id?.toString() === t.variantId);
          if (v) {
            available = v.quantity || 0;
            minStock = v.minStock ?? doc.minStock ?? 0;
          }
        }
        if (available === null) {
          available = doc.quantity || 0;
          minStock = doc.minStock || 0;
        }
      }

      // Collect unitConversions — must be before shortfall computation
      let unitConversions = [];
      if (doc) {
        let varDoc = null;
        if (t.variantId && Array.isArray(doc.variants)) {
          varDoc = doc.variants.find(vv => vv._id?.toString() === t.variantId);
        }
        if (!varDoc && Array.isArray(doc.variants) && doc.variants.length > 0) {
          varDoc = doc.variants[0];
        }
        if (varDoc?.unitConversions?.length) {
          unitConversions = varDoc.unitConversions;
        } else if (varDoc?.unitConversion?.toUnit) {
          unitConversions = [varDoc.unitConversion];
        }
      }

      // Convert available from raw item's native baseUnit → BOM unit before comparing.
 
      // Convert available from raw item's native baseUnit → BOM unit before comparing.
      // e.g. available=148 Pkt, BOM unit=Pcs, conversion 1 Pkt=300 Pcs → 44,400 Pcs available.
      let availableInBomUnit = available;
      if (available !== null && t.baseUnit && t.unit && t.baseUnit !== t.unit) {
        const converted = convertBetweenUnits(available, t.baseUnit, t.unit, unitConversions);
        if (converted !== null) availableInBomUnit = converted;
      }

      const shortfall = availableInBomUnit !== null ? Math.max(0, t.quantityRequired - availableInBomUnit) : null;

      let status = "unknown";
      if (availableInBomUnit !== null) {
        if (availableInBomUnit <= 0) status = "out_of_stock";
        else if (shortfall > 0) status = "shortage";
        else if (availableInBomUnit - t.quantityRequired <= minStock) status = "low";
        else status = "ok";
      }
 
      totalRequired += t.quantityRequired;
      if (available !== null) totalAvailable += available;
      if (shortfall && shortfall > 0) shortfallCount++;
 
      totals.push({
        ...t,
        available,
        availableInBomUnit,
        shortfall,
        minStock,
        status,
        unitConversions,
      });
    }
 
    // ── Committed stock: remaining balance owed to other active orders ────────
    // committed per order = max(0, total WO needed − already issued to it)
    // This is what still needs to leave stock, so must be reserved for them.
    try {
      // Only consider orders created BEFORE this one — they have stock priority
        const currentRequest = await CustomerRequest.findById(requestId).select("createdAt").lean();
        const activeMOs = await CustomerRequest.find({
          status: { $in: ["quotation_sales_approved", "in_progress", "production"] },
          _id: { $ne: new mongoose.Types.ObjectId(requestId) },
          createdAt: { $lt: currentRequest?.createdAt || new Date() },
        }).select("_id requestId customerInfo items createdAt").lean();

      if (activeMOs.length > 0) {
        const activeMOIds = activeMOs.map(m => m._id);
        const activeMOMap = new Map(activeMOs.map(m => [m._id.toString(), m]));

        // 1. Derive needed raw items from CustomerRequest → StockItem BOM
        //    Same source of truth as the current order's computation — avoids WO stale data.
        const activeCRs = await CustomerRequest.find({ _id: { $in: activeMOIds } })
          .select("_id requestId customerInfo items").lean();

        // Batch-fetch all StockItems referenced by active CRs
        const activeSidSet = new Set();
        for (const cr of activeCRs) {
          for (const it of (cr.items || [])) {
            if (it.stockItemId) activeSidSet.add(it.stockItemId.toString());
          }
        }
        const activeSIs = activeSidSet.size
          ? await StockItem.find({ _id: { $in: [...activeSidSet] } }).lean()
          : [];
        const activeSIMap = new Map(activeSIs.map(s => [s._id.toString(), s]));

        const neededMap = {}; // key → { [moId]: { moNumber, customerName, needed, unit } }
        const norm = s => String(s || "").trim().toLowerCase();

        for (const cr of activeCRs) {
          const moId = cr._id.toString();
          for (const crItem of (cr.items || [])) {
            const si = activeSIMap.get(crItem.stockItemId?.toString());
            if (!si) continue;

            for (const crVariant of (crItem.variants || [])) {
              const qtyOrdered = crVariant.quantity || 0;
              if (!qtyOrdered) continue;

              // Match StockItem variant by attributes, fall back to first
              const reqAttrs = crVariant.attributes || [];
              let siVariant = null;
              if (reqAttrs.length > 0) {
                siVariant = (si.variants || []).find(v => {
                  const vAttrs = v.attributes || [];
                  return vAttrs.length === reqAttrs.length &&
                    reqAttrs.every(ra => vAttrs.some(va =>
                      norm(va.name) === norm(ra.name) && norm(va.value) === norm(ra.value)
                    ));
                });
              }
              if (!siVariant) siVariant = si.variants?.[0];
              if (!siVariant) continue;

              for (const ri of (siVariant.rawItems || [])) {
                if (!ri.rawItemId) continue;
                const riId   = ri.rawItemId.toString();
                const rvId   = ri.variantId?.toString() || "none";
                const key    = `${riId}|${rvId}`;
                const needed = (ri.quantity || 0) * qtyOrdered;
                if (!needed) continue;

                if (!neededMap[key])       neededMap[key]       = {};
                if (!neededMap[key][moId]) neededMap[key][moId] = {
                  moNumber:     cr.requestId          || "—",
                  customerName: cr.customerInfo?.name || "—",
                  needed: 0,
                  unit:   ri.unit || "",
                };
                neededMap[key][moId].needed += needed;
              }
            }
          }
        }

        // 2. How much has already been issued to those orders (native unit)
        const otherIssuances = await StockIssuance.find({
          manufacturingOrder: { $in: activeMOIds },
        }).lean();

        const issuedMap = {}; // key → { [moId]: { issuedNative, nativeUnit } }
        for (const iso of otherIssuances) {
          const moId = iso.manufacturingOrder?.toString();
          for (const itm of (iso.items || [])) {
            const riId = itm.rawItem?.toString();
            const rvId = itm.variantId?.toString() || "none";
            const key  = `${riId}|${rvId}`;
            if (!issuedMap[key])       issuedMap[key]       = {};
            if (!issuedMap[key][moId]) issuedMap[key][moId] = { issuedNative: 0, nativeUnit: itm.nativeUnit || "" };
            const signed = iso.direction === "debit" ? (itm.nativeQty || 0) : -(itm.nativeQty || 0);
            issuedMap[key][moId].issuedNative += signed;
          }
        }

        // 3. Second pass: remaining = needed(BOM unit) − issued(converted to BOM unit)
        for (const item of totals) {
          const key        = `${item.rawItemId}|${item.variantId || "none"}`;
          const neededByMO = neededMap[key] || {};
          const issuedByMO = issuedMap[key] || {};
          const bomUnit    = item.unit;
          const convs      = item.unitConversions || [];

          const orders = [];
          let totalRemainingBom = 0;

          for (const [moId, needData] of Object.entries(neededByMO)) {
            const neededBom = needData.needed; // already in BOM unit from WO

            // Convert issued native → BOM unit
            const issuedData  = issuedByMO[moId] || { issuedNative: 0, nativeUnit: "" };
            let   issuedBom   = issuedData.issuedNative;
            const iNativeUnit = issuedData.nativeUnit || bomUnit;

            if (iNativeUnit && bomUnit && iNativeUnit !== bomUnit && issuedBom > 0) {
              const conv = convs.find(uc =>
                (uc.fromUnit === iNativeUnit && uc.toUnit === bomUnit) ||
                (uc.fromUnit === bomUnit     && uc.toUnit === iNativeUnit)
              );
              if (conv?.quantity) {
                issuedBom = conv.fromUnit === iNativeUnit
                  ? issuedBom * conv.quantity
                  : issuedBom / conv.quantity;
              }
            }

            const remaining = Math.max(0, neededBom - issuedBom);
            if (remaining > 0.0001) {
              orders.push({
                moNumber:     needData.moNumber,
                customerName: needData.customerName,
                needed:       neededBom,
                issued:       issuedBom,
                remaining,
                unit:         bomUnit,
              });
              totalRemainingBom += remaining;
            }
          }

          item.committedInBomUnit    = totalRemainingBom;
          item.committedOrders       = orders;
          item.netAvailableInBomUnit = Math.max(0, (item.availableInBomUnit || 0) - totalRemainingBom);

          const net      = item.netAvailableInBomUnit;
          item.shortfall = Math.max(0, item.quantityRequired - net);
          if      (net <= 0)                                    item.status = "out_of_stock";
          else if (item.shortfall > 0.001)                      item.status = "shortage";
          else if (net - item.quantityRequired <= item.minStock) item.status = "low";
          else                                                   item.status = "ok";
        }

        shortfallCount = totals.filter(t => (t.shortfall || 0) > 0).length;
      }
    } catch (committedErr) {
      console.error("Committed stock lookup (non-fatal):", committedErr.message);
    }

    // Defaults for entries not touched above
    for (const item of totals) {
      if (item.committedInBomUnit    === undefined) item.committedInBomUnit    = 0;
      if (!item.committedOrders)                   item.committedOrders       = [];
      if (item.netAvailableInBomUnit === undefined) item.netAvailableInBomUnit = item.availableInBomUnit;
    }

    // Sort totals: shortages first, then low, then ok
    const statusRank = { out_of_stock: 0, shortage: 1, low: 2, ok: 3, unknown: 4 };
    totals.sort((a, b) => {
      const r = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (r !== 0) return r;
      return (a.rawItemName || "").localeCompare(b.rawItemName || "");
    });
 
    return res.json({
      success: true,
      perProduct,
      totals,
      grand: {
        totalLineItems: totals.length,
        totalRequired,
        totalAvailable,
        shortfallCount,
      },
      sizeResolution,
    });
  } catch (err) {
    console.error("Raw-item requirement error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════
// 3) ASSIGN DEADLINE — bulk
//    Frontend: POST /api/cms/sales/work-orders/assign-deadlines-batch
//    Body: { workOrderIds: [...], deadline: "2026-06-15" | null }
// ═══════════════════════════════════════════════════════════════════════════
router.post("/work-orders/assign-deadlines-batch", async (req, res) => {
  try {
    const { workOrderIds, deadline } = req.body;
    if (!Array.isArray(workOrderIds) || workOrderIds.length === 0) {
      return res.status(400).json({ success: false, message: "workOrderIds array is required" });
    }
 
    const isClearing = deadline === null || deadline === "";
    let parsed = null;
    if (!isClearing) {
      parsed = new Date(deadline);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid deadline date" });
      }
    }
 
    const update = isClearing
      ? {
          $set: {
            assignedDeadline: null,
            "assignedDeadlineMeta.assignedAt": null,
            "assignedDeadlineMeta.assignedBy": null,
          },
        }
      : {
          $set: {
            assignedDeadline: parsed,
            "assignedDeadlineMeta.assignedAt": new Date(),
            "assignedDeadlineMeta.assignedBy": req.user?.id || null,
          },
        };
 
    const result = await WorkOrder.updateMany({ _id: { $in: workOrderIds } }, update);
 
    return res.json({
      success: true,
      message: `${result.modifiedCount} work order${result.modifiedCount !== 1 ? "s" : ""} updated`,
      modifiedCount: result.modifiedCount,
      workOrderIds,
      deadline: isClearing ? null : parsed,
    });
  } catch (err) {
    console.error("Batch assign deadline error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/requests/:requestId/employee-progress", async (req, res) => {
  try {
    const { requestId } = req.params;
    const progress = await EmployeeProductionProgress.find({
      manufacturingOrderId: requestId,
    })
      .populate({
        path: "workOrderId",
        select: "stockItemName stockItemReference workOrderNumber variantAttributes variantId stockItemId",
        populate: {
          path: "stockItemId",
          select: "images variants.images variants._id variants.attributes",
        },
      })
      .lean();
    res.json({ success: true, progress });
  } catch (err) {
    console.error("Employee progress fetch error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/requests/:requestId/work-orders", async (req, res) => {
  try {
    const { requestId } = req.params;
    const workOrders = await WorkOrder.find({ customerRequestId: requestId })
      .populate({
        path: "stockItemId",
        select: "name reference genderCategory category images variants.images variants.attributes variants._id",
      })
      .sort({ createdAt: 1 })
      .lean();
    return res.json({ success: true, workOrders });
  } catch (err) {
    console.error("Fetch work orders error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// CREATE quotation for a request
router.post("/requests/:requestId/quotation", async (req, res) => {
  try {
    const { requestId } = req.params;
    const quotationData = req.body;
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const existingQuotation = request.quotations.length > 0 ? request.quotations[0] : null;
    const quotationNumber = existingQuotation ? existingQuotation.quotationNumber : `QT-${request.requestId}-001`;

    const itemsWithCalculations = await Promise.all(quotationData.items.map(async (item) => {
      let stockItem = null;
      if (item.stockItemId) stockItem = await StockItem.findById(item.stockItemId);
      const unitPrice = parseFloat(item.unitPrice) || 0;
      const gstPercentage = getGSTPercentage(unitPrice);
      const quantity = parseFloat(item.quantity) || 0;
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(quantity, unitPrice, gstPercentage);
      const discountPercentage = parseFloat(item.discountPercentage) || 0;
      const discountAmount = priceBeforeGST * (discountPercentage / 100);
      const discountedBase = priceBeforeGST - discountAmount;
      const discountedGST = discountedBase * (gstPercentage / 100);
      const discountedTotal = discountedBase + discountedGST;
      return {
        ...item, gstPercentage,
        priceBeforeGST: discountPercentage > 0 ? parseFloat(discountedBase.toFixed(2)) : priceBeforeGST,
        gstAmount: discountPercentage > 0 ? parseFloat(discountedGST.toFixed(2)) : gstAmount,
        priceIncludingGST: discountPercentage > 0 ? parseFloat(discountedTotal.toFixed(2)) : priceIncludingGST,
        discountAmount: parseFloat(discountAmount.toFixed(2)),
        hsnCode: item.hsnCode || stockItem?.hsnCode || stockItem?.hsn_code || '',
        stockInfo: { quantityOnHand: stockItem?.quantityOnHand || 0, status: stockItem?.status || 'Unknown' }
      };
    }));

    const subtotalBeforeGST = itemsWithCalculations.reduce((sum, item) => sum + (item.priceBeforeGST || 0), 0);
    const totalDiscount = itemsWithCalculations.reduce((sum, item) => sum + (item.discountAmount || 0), 0);
    const totalGST = itemsWithCalculations.reduce((sum, item) => sum + (item.gstAmount || 0), 0);
    const shippingCharges = parseFloat(quotationData.shippingCharges) || 0;
    const customAdditionalCharges = quotationData.customAdditionalCharges || [];
    const totalCustomCharges = customAdditionalCharges.reduce((sum, charge) => sum + (charge.amount || 0), 0);
    const grandTotal = subtotalBeforeGST + totalGST + shippingCharges + totalCustomCharges;

    // ── Resolve the status this save should land on ─────────────────────────
    // The popup always posts `status: 'draft'` when the user hits Save, even on
    // a quotation that is already sent/approved. Honour a forward move only;
    // anything backwards keeps the stored status.
    const previousStatus = existingQuotation?.status || null;
    const requestedStatus = quotationData.status || previousStatus || 'draft';
    const resolvedStatus = isQuotationRegression(previousStatus, requestedStatus)
      ? previousStatus
      : requestedStatus;

    const quotation = {
      ...quotationData, items: itemsWithCalculations, customAdditionalCharges,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      shippingCharges: parseFloat(shippingCharges.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      quotationNumber, preparedBy: req.user.id,
      status: resolvedStatus, updatedAt: new Date()
    };

    if (existingQuotation) {
      // Never let a re-save wipe the approval trail, the recorded payments, or
      // the customer's submitted receipts — the popup does not send these back.
      quotation.paymentSchedule = preservePaymentState(
        existingQuotation.paymentSchedule, quotation.paymentSchedule || [],
      );
      delete quotation.paymentSubmissions;
      delete quotation.customerApproval;
      delete quotation.salesApproval;
      delete quotation.accountantApproval;
      delete quotation.sentToCustomerAt;
      delete quotation.sentBy;
      delete quotation._id;
    }

    if (!existingQuotation) { quotation.createdAt = new Date(); request.quotations.push(quotation); }
    else Object.assign(existingQuotation, quotation);

    const currentQuotation = existingQuotation || request.quotations[request.quotations.length - 1];
    request.currentQuotation = currentQuotation._id;

    if (resolvedStatus === 'sent_to_customer' && previousStatus !== 'sent_to_customer') {
      currentQuotation.sentToCustomerAt = new Date();
      currentQuotation.sentBy = req.user.id;
    }
    // request.status is always a projection of the quotation status — never set
    // directly, so a save can't bounce an approved order back to draft.
    syncRequestStatusFromQuotation(request, currentQuotation);

    request.taxSummary = { totalGST, sgst: totalGST / 2, cgst: totalGST / 2, igst: 0 };
    request.quotationValidUntil = new Date(quotationData.validUntil);
    request.updatedAt = new Date();
 
    // ── Sync request.items + customerInfo when flagged by frontend ───────────
    if (quotationData._syncRequestItems) {
      console.log(`[quotationRoutes] _syncRequestItems triggered — ${itemsWithCalculations.length} item(s) in quotation`);
 
      const attrsMatch = (a = [], b = []) => {
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        return a.every(qa => b.some(va => va.name === qa.name && va.value === qa.value));
      };
 
      // ── 1. Sync customer info if provided ──────────────────────────────────
      if (quotationData.customerInfo) {
        const ci = quotationData.customerInfo;
        const fields = ["name", "email", "phone", "address", "city", "postalCode",
                        "deliveryDeadline", "preferredContactMethod", "description"];
        fields.forEach(f => {
          if (ci[f] !== undefined && ci[f] !== null) {
            request.customerInfo[f] = ci[f];
          }
        });
        request.markModified("customerInfo");
        console.log(`[quotationRoutes] customerInfo synced — name: ${ci.name}`);
      }
 
      // ── 2. Build set of stockItemIds still in the quotation ────────────────
      const qItemSids = new Set(
        itemsWithCalculations.map(qi => (qi.stockItemId?._id || qi.stockItemId)?.toString()).filter(Boolean)
      );
 
      // ── 3. Remove request items that were deleted from the quotation ────────
      //       Only remove non-new items (items that existed before this quotation was created)
      //       Keep items that have no corresponding quotation item and are NOT _isNew
      const removedItems = [];
      request.items = request.items.filter(reqItem => {
        const iSid = (reqItem.stockItemId?._id || reqItem.stockItemId)?.toString();
        // Keep if still present in quotation
        if (qItemSids.has(iSid)) return true;
        // Keep if it was never part of this quotation flow (e.g. measurement items)
        // Only remove if this quotation explicitly had items and this one was removed
        removedItems.push(reqItem.stockItemName || iSid);
        return false;
      });
      if (removedItems.length > 0) {
        console.log(`[quotationRoutes] Items removed from request: ${removedItems.join(", ")}`);
      }
 
      // ── 4. Sync qty + price for each quotation item ─────────────────────────
      for (const qItem of itemsWithCalculations) {
        const qSid = (qItem.stockItemId?._id || qItem.stockItemId)?.toString();
        const qAttrs = qItem.attributes || [];
 
        // Find matching request item
        const reqItem = request.items.find(i => {
          const iSid = (i.stockItemId?._id || i.stockItemId)?.toString();
          return iSid === qSid;
        });
 
        if (reqItem) {
          // Find matching variant by attributes, fall back to first
          const variant = qAttrs.length > 0
            ? (reqItem.variants.find(v => attrsMatch(qAttrs, v.attributes || [])) || reqItem.variants[0])
            : reqItem.variants[0];
 
          if (variant) {
            const oldQty   = variant.quantity;
            const oldPrice = variant.estimatedPrice;
            const newPrice = parseFloat((qItem.priceIncludingGST || 0).toFixed(2));
 
            if (oldQty !== qItem.quantity || oldPrice !== newPrice) {
              console.log(
                `[quotationRoutes] Syncing "${reqItem.stockItemName || reqItem.mpcDisplayName}": ` +
                `qty ${oldQty}→${qItem.quantity}, price ${oldPrice}→${newPrice}`
              );
            }
            variant.quantity       = qItem.quantity;
            variant.estimatedPrice = newPrice;
          }
 
          // Recalc item totals
          reqItem.totalQuantity      = reqItem.variants.reduce((s, v) => s + (v.quantity || 0), 0);
          reqItem.totalEstimatedPrice = parseFloat(
            reqItem.variants.reduce((s, v) => s + (v.estimatedPrice || 0), 0).toFixed(2)
          );
 
        } else if (qItem._isNew) {
          // New product added via quotation search — push to request.items
          console.log(`[quotationRoutes] New item added to request: "${qItem.itemName}"`);
          request.items.push({
            stockItemId:         qItem.stockItemId,
            stockItemName:       qItem.description || qItem.itemName || "",
            stockItemReference:  qItem.itemCode    || "",
            mpcDisplayName:      qItem.itemName    || "",
            genderCategory:      qItem.genderCategory || "",
            variants: [{
              attributes:          qItem.attributes || [],
              quantity:            qItem.quantity,
              estimatedPrice:      parseFloat((qItem.priceIncludingGST || 0).toFixed(2)),
              specialInstructions: [],
            }],
            totalQuantity:       qItem.quantity,
            totalEstimatedPrice: parseFloat((qItem.priceIncludingGST || 0).toFixed(2)),
          });
        }
      }
 
      request.markModified("items");
      console.log(`[quotationRoutes] Sync complete — ${request.items.length} item(s) in request`);
    }
 
    await request.save();

    res.json({ success: true, message: existingQuotation ? "Quotation updated successfully" : "Quotation created successfully", quotation: currentQuotation, request });
  } catch (error) {
    console.error("Error saving quotation:", error);
    res.status(500).json({ success: false, message: "Server error while saving quotation" });
  }
});

// UPDATE quotation
// ─── REVISE ───────────────────────────────────────────────────────────────────
// Open the next round of a negotiation.
//
// A quotation that has gone to a customer is a statement of what we offered on
// a date. Editing it in place — which is what POST .../quotation does, and all
// it could do while a request held exactly one — erases that: the price they
// rejected, the date it went out and their reason all vanish behind the new
// number, and nobody can answer "what did we quote them in August".
//
// So the current round is ARCHIVED WHOLE into `quotationRevisions` and
// `quotations[0]` becomes a fresh draft carrying the same lines forward. Index
// 0 stays the current quotation, which is what every other reader in this
// codebase already assumes — the accountant module, the dashboard, send,
// approve and reject all keep working untouched.
//
// A DRAFT IS NOT REVISED, it is edited. Revising one would archive a round the
// customer never saw and burn a revision number on nothing.
router.post("/requests/:requestId/quotation/revise", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body || {};

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (!request.quotations.length) {
      return res.status(400).json({ success: false, message: "There is no quotation to revise" });
    }

    const current = request.quotations[0];
    if (current.status === "draft") {
      return res.status(400).json({
        success: false,
        message: "This quotation is still a draft — edit it rather than revising it.",
      });
    }

    // Snapshot first. `toObject` so the archived copy is detached from the
    // subdocument we are about to overwrite.
    const archived = current.toObject();
    const archivedId = archived._id;
    request.quotationRevisions.push(archived);

    const nextRevision = (current.revision || 1) + 1;
    // Strip any existing -R<n> so numbers read QT-REQ-001-R2, never -R2-R3.
    const base = String(current.quotationNumber || "").replace(/-R\d+$/, "");

    // The new round starts from the last offer: same lines, same terms. That is
    // what a negotiation is — one figure moves, not the whole document.
    current.revision = nextRevision;
    current.revisionReason = (reason || "").trim() || undefined;
    current.supersedesQuotationId = archivedId;
    current.quotationNumber = `${base}-R${nextRevision}`;
    current.status = "draft";
    current.date = new Date();

    // Everything the previous round earned belongs to the previous round.
    current.sentToCustomerAt = undefined;
    current.sentBy = undefined;
    current.customerApproval = undefined;
    current.salesApproval = undefined;
    current.accountantApproval = undefined;
    current.paymentSubmissions = [];

    await request.save();

    res.json({
      success: true,
      message: `Revision ${nextRevision} opened`,
      quotation: request.quotations[0],
      revisions: request.quotationRevisions,
    });
  } catch (error) {
    console.error("Error revising quotation:", error);
    res.status(500).json({ success: false, message: "Server error while revising quotation" });
  }
});

// ─── REVISION HISTORY ─────────────────────────────────────────────────────────
// Read-only. The current round plus every round it replaced, oldest first.
router.get("/requests/:requestId/quotation/revisions", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId)
      .select("quotations quotationRevisions requestId")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    res.json({
      success: true,
      current: request.quotations?.[0] || null,
      revisions: request.quotationRevisions || [],
    });
  } catch (error) {
    console.error("Error loading quotation revisions:", error);
    res.status(500).json({ success: false, message: "Server error while loading revisions" });
  }
});

router.put("/requests/:requestId/quotation/:quotationId", async (req, res) => {
  try {
    const { requestId, quotationId } = req.params;
    const quotationData = req.body;
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    if (quotation.status !== 'draft') return res.status(400).json({ success: false, message: "Only draft quotations can be updated" });

    const itemsWithCalculations = await Promise.all(quotationData.items.map(async (item) => {
      let stockItem = null;
      if (item.stockItemId) stockItem = await StockItem.findById(item.stockItemId);
      const unitPrice = parseFloat(item.unitPrice) || 0;
      const gstPercentage = getGSTPercentage(unitPrice);
      const quantity = parseFloat(item.quantity) || 0;
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(quantity, unitPrice, gstPercentage);
      const discountPercentage = parseFloat(item.discountPercentage) || 0;
      const discountAmount = priceBeforeGST * (discountPercentage / 100);
      const discountedBase = priceBeforeGST - discountAmount;
      const discountedGST = discountedBase * (gstPercentage / 100);
      const discountedTotal = discountedBase + discountedGST;
      return {
        ...item, gstPercentage,
        priceBeforeGST: discountPercentage > 0 ? parseFloat(discountedBase.toFixed(2)) : priceBeforeGST,
        gstAmount: discountPercentage > 0 ? parseFloat(discountedGST.toFixed(2)) : gstAmount,
        priceIncludingGST: discountPercentage > 0 ? parseFloat(discountedTotal.toFixed(2)) : priceIncludingGST,
        discountAmount: parseFloat(discountAmount.toFixed(2))
      };
    }));

    const subtotalBeforeGST = itemsWithCalculations.reduce((s, i) => s + (i.priceBeforeGST || 0), 0);
    const totalDiscount = itemsWithCalculations.reduce((s, i) => s + (i.discountAmount || 0), 0);
    const totalGST = itemsWithCalculations.reduce((s, i) => s + (i.gstAmount || 0), 0);
    const shippingCharges = parseFloat(quotationData.shippingCharges) || 0;
    const adjustment = parseFloat(quotationData.adjustment) || 0;
    const grandTotal = subtotalBeforeGST + totalGST + shippingCharges + adjustment;

    Object.assign(quotation, {
      ...quotationData, items: itemsWithCalculations,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)), totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)), shippingCharges: parseFloat(shippingCharges.toFixed(2)),
      adjustment: parseFloat(adjustment.toFixed(2)), grandTotal: parseFloat(grandTotal.toFixed(2)), updatedAt: new Date()
    });

    request.taxSummary = { totalGST, sgst: totalGST / 2, cgst: totalGST / 2, igst: 0 };
    request.quotationValidUntil = new Date(quotationData.validUntil);
    request.updatedAt = new Date();
    await request.save();
    res.json({ success: true, message: "Quotation updated successfully", quotation, request });
  } catch (error) {
    console.error("Error updating quotation:", error);
    res.status(500).json({ success: false, message: "Server error while updating quotation" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH ADD EMPLOYEES TO MEASUREMENT-PO  (NEW)
//
// Body: { employeeIds: [id1, id2, id3, ...] }
//
// Loads request + measurement ONCE, processes each employee sequentially,
// caches WO docs across the loop so multiple employees adding to the same WO
// keep allocating non-overlapping unit ranges, then saves everything once.
//
// Returns per-employee results (succeeded/failed/skipped) so the UI can show
// exactly what happened.
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/requests/:requestId/add-employees-batch", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { employeeIds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ success: false, message: "employeeIds array required" });
    }

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Only available for measurement POs" });
    }

    const measurement = await Measurement.findById(request.measurementId);
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    // Caches that persist across the entire batch
    const woCache = new Map();           // woIdStr -> WO doc (loaded once, mutated, saved at end)
    const woOriginalQty = new Map();     // woIdStr -> qty BEFORE this batch (for proportional raw-material calc)
    const woMaxUnitCache = new Map();    // woIdStr -> current max unitEnd (advances as we allocate)
    const queuedProgressDocs = [];
    const perEmployeeResults = [];

    for (const employeeId of employeeIds) {
      const result = {
        employeeId,
        employeeName: null,
        success: false,
        addedProducts: [],
        skippedProducts: [],
        error: null,
      };

      try {
        if (!mongoose.Types.ObjectId.isValid(employeeId)) {
          result.error = "Invalid employee id";
          perEmployeeResults.push(result);
          continue;
        }

        const employee = await EmployeeMpc.findById(employeeId)
          .populate("products.productId", "name reference")
          .lean();

        if (!employee) { result.error = "Employee not found"; perEmployeeResults.push(result); continue; }
        result.employeeName = employee.name;

        if (measurement.organizationId.toString() !== employee.customerId?.toString()) {
          result.error = "Employee not in this organization";
          perEmployeeResults.push(result); continue;
        }

        const alreadyExists = (measurement.employeeMeasurements || []).some(
          (e) => e.employeeId?.toString() === employeeId.toString()
        );
        if (alreadyExists) {
          result.error = "Already in PO";
          perEmployeeResults.push(result); continue;
        }

        if (!employee.products || employee.products.length === 0) {
          result.error = "No products assigned";
          perEmployeeResults.push(result); continue;
        }

        const productsToAddToMeasurement = [];
        const employeeProgressDocs = [];

        for (const empProd of employee.products) {
          const empProdId = (empProd.productId?._id || empProd.productId)?.toString();
          const empVariantId = empProd.variantId?.toString() || null;
          const qty = empProd.quantity || 1;
          const empProdName = empProd.productName?.trim() || empProd.productId?.name || "Unknown";

          if (!empProdId) {
            result.skippedProducts.push({ productName: empProdName, reason: "Missing productId" });
            continue;
          }

          // Locate request item
          const reqItem = request.items.find((it) => {
            const iid = (it.stockItemId?._id || it.stockItemId)?.toString();
            return iid === empProdId;
          });
          if (!reqItem) {
            result.skippedProducts.push({ productName: empProdName, reason: "Not in PO" });
            continue;
          }

          // Locate matching WO — first check cache, fall back to DB query
          let matchingWO = null;

          // Try cache first
          for (const cachedWO of woCache.values()) {
            if (cachedWO.stockItemId.toString() !== reqItem.stockItemId.toString()) continue;
            if (empVariantId && cachedWO.variantId === empVariantId) { matchingWO = cachedWO; break; }
          }

          if (!matchingWO) {
            const candidateWOs = await WorkOrder.find({
              customerRequestId: request._id,
              stockItemId: reqItem.stockItemId,
            });

            let foundWO = null;
            if (empVariantId) foundWO = candidateWOs.find((w) => w.variantId === empVariantId);
            if (!foundWO && candidateWOs.length > 0) foundWO = candidateWOs[0];

            if (foundWO) {
              const woIdStr = foundWO._id.toString();
              if (woCache.has(woIdStr)) {
                matchingWO = woCache.get(woIdStr);
              } else {
                woCache.set(woIdStr, foundWO);
                woOriginalQty.set(woIdStr, foundWO.quantity || 0);

                const lastProgress = await EmployeeProductionProgress.find({ workOrderId: foundWO._id })
                  .select("unitEnd")
                  .sort({ unitEnd: -1 })
                  .limit(1)
                  .lean();
                woMaxUnitCache.set(woIdStr, lastProgress[0]?.unitEnd || 0);
                matchingWO = foundWO;
              }
            }
          }

          if (!matchingWO) {
            result.skippedProducts.push({ productName: empProdName, reason: "No matching work order" });
            continue;
          }

          const blockedStatuses = ["completed", "cancelled", "forwarded"];
          if (blockedStatuses.includes(matchingWO.status)) {
            result.skippedProducts.push({ productName: empProdName, reason: `WO is ${matchingWO.status}` });
            continue;
          }

          const woIdStr = matchingWO._id.toString();

          // Find request variant matching this WO
          let reqVariant = null;
          if (empVariantId) {
            reqVariant = reqItem.variants.find((v) => v.variantId && v.variantId.toString() === empVariantId);
          }
          if (!reqVariant && matchingWO.variantAttributes?.length) {
            reqVariant = reqItem.variants.find((v) => {
              if (!v.attributes || v.attributes.length === 0) return false;
              return matchingWO.variantAttributes.every((wa) =>
                v.attributes.find((a) => a.name === wa.name && a.value === wa.value)
              );
            });
          }
          if (!reqVariant && reqItem.variants.length > 0) reqVariant = reqItem.variants[0];

          if (!reqVariant) {
            result.skippedProducts.push({ productName: empProdName, reason: "No variant entry to extend" });
            continue;
          }

          // Allocate unit range from in-memory cursor
          const currentMax = woMaxUnitCache.get(woIdStr);
          const unitStart = currentMax + 1;
          const unitEnd = currentMax + qty;
          woMaxUnitCache.set(woIdStr, unitEnd);

          const woNumber = matchingWO.workOrderNumber;
          const assignedBarcodeIds = [];
          for (let u = unitStart; u <= unitEnd; u++) {
            assignedBarcodeIds.push(`${woNumber}-${u.toString().padStart(3, "0")}`);
          }

          // Mutate WO quantity in-memory (raw materials recalc once per WO at end)
          matchingWO.quantity = (matchingWO.quantity || 0) + qty;

          // Mutate request item in-memory
          const oldVariantQty = reqVariant.quantity || 0;
          reqVariant.quantity = oldVariantQty + qty;
          reqItem.totalQuantity = (reqItem.totalQuantity || 0) + qty;

          if (oldVariantQty > 0 && reqVariant.estimatedPrice) {
            const perUnitPrice = reqVariant.estimatedPrice / oldVariantQty;
            const newVariantPrice = perUnitPrice * reqVariant.quantity;
            const priceDelta = newVariantPrice - reqVariant.estimatedPrice;
            reqVariant.estimatedPrice = parseFloat(newVariantPrice.toFixed(2));
            reqItem.totalEstimatedPrice = parseFloat(((reqItem.totalEstimatedPrice || 0) + priceDelta).toFixed(2));
          }

          productsToAddToMeasurement.push({
            productId: empProd.productId?._id || empProd.productId,
            productName: empProdName,
            variantId: empProd.variantId || null,
            variantName: "Default",
            quantity: qty,
            measurements: [],
            measuredAt: new Date(),
            qrGenerated: false,
            qrGeneratedAt: null,
          });

          employeeProgressDocs.push({
            workOrderId: matchingWO._id,
            manufacturingOrderId: request._id,
            measurementId: measurement._id,
            orderType: "measurement_conversion",
            employeeId: employee._id,
            employeeName: employee.name,
            employeeUIN: employee.uin,
            gender: employee.gender,
            unitStart, unitEnd, totalUnits: qty,
            assignedBarcodeIds,
            productName: empProdName,
          });

          result.addedProducts.push({
            productName: empProdName,
            unitStart, unitEnd, totalUnits: qty,
          });
        }

        if (productsToAddToMeasurement.length === 0) {
          result.error = "No products could be added — all skipped";
          perEmployeeResults.push(result);
          continue;
        }

        // Push to measurement
        measurement.employeeMeasurements.push({
          employeeId: employee._id,
          employeeName: employee.name,
          employeeUIN: employee.uin,
          gender: employee.gender,
          products: productsToAddToMeasurement,
          noProductAssigned: false,
          categoryMeasurements: [],
          isCompleted: false,
          remarks: "",
        });

        if (!(measurement.registeredEmployeeIds || []).some((id) => id.toString() === employee._id.toString())) {
          measurement.registeredEmployeeIds = measurement.registeredEmployeeIds || [];
          measurement.registeredEmployeeIds.push(employee._id);
        }
        if (!(measurement.poCreatedForEmployeeIds || []).some((id) => id.toString() === employee._id.toString())) {
          measurement.poCreatedForEmployeeIds = measurement.poCreatedForEmployeeIds || [];
          measurement.poCreatedForEmployeeIds.push(employee._id);
        }

        queuedProgressDocs.push(...employeeProgressDocs);
        result.success = true;
        perEmployeeResults.push(result);
      } catch (innerErr) {
        console.error(`[batch-add] Error processing employee ${employeeId}:`, innerErr);
        result.error = innerErr.message || "Processing error";
        perEmployeeResults.push(result);
      }
    }

    // ── Update each touched WO once: raw materials proportional + cost ───
    for (const wo of woCache.values()) {
      const woIdStr = wo._id.toString();
      const oldQty = woOriginalQty.get(woIdStr);
      const newQty = wo.quantity;

      if (wo.rawMaterials && wo.rawMaterials.length > 0 && oldQty > 0 && newQty > oldQty) {
        for (const rm of wo.rawMaterials) {
          const perUnitQty = (rm.quantityRequired || 0) / oldQty;
          const perUnitCost = (rm.totalCost || 0) / oldQty;
          rm.quantityRequired = parseFloat((perUnitQty * newQty).toFixed(4));
          rm.totalCost = parseFloat((perUnitCost * newQty).toFixed(2));
        }
      }
      wo.estimatedCost = (wo.rawMaterials || []).reduce((s, rm) => s + (rm.totalCost || 0), 0);
      await wo.save();
    }

    // Update measurement counts for newly-added employees
    const newlyAdded = perEmployeeResults.filter((r) => r.success).length;
    if (newlyAdded > 0) {
      measurement.totalRegisteredEmployees = (measurement.totalRegisteredEmployees || 0) + newlyAdded;
      measurement.pendingEmployees = (measurement.pendingEmployees || 0) + newlyAdded;
    }

    await measurement.save();
    request.markModified("items");
    request.updatedAt = new Date();
    await request.save();

    // Create progress docs
    for (const pd of queuedProgressDocs) {
      try {
        await EmployeeProductionProgress.findOneAndUpdate(
          { workOrderId: pd.workOrderId, employeeId: pd.employeeId },
          {
            $set: {
              measurementId: pd.measurementId,
              manufacturingOrderId: pd.manufacturingOrderId,
              orderType: pd.orderType,
              employeeName: pd.employeeName,
              employeeUIN: pd.employeeUIN,
              gender: pd.gender,
              unitStart: pd.unitStart,
              unitEnd: pd.unitEnd,
              totalUnits: pd.totalUnits,
              assignedBarcodeIds: pd.assignedBarcodeIds,
              completedUnits: 0,
              completedUnitNumbers: [],
              completionPercentage: 0,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true, new: true }
        );
      } catch (progressErr) {
        console.error(`[batch-add] Progress doc error for ${pd.employeeName}:`, progressErr.message);
      }
    }

    const successCount = perEmployeeResults.filter((r) => r.success).length;
    const failCount = perEmployeeResults.length - successCount;
    const totalUnits = perEmployeeResults.reduce(
      (s, r) => s + (r.addedProducts?.reduce((s2, p) => s2 + p.totalUnits, 0) || 0),
      0
    );

    res.json({
      success: true,
      message: `Added ${successCount} of ${employeeIds.length} employee(s) · ${totalUnits} unit(s) total${failCount > 0 ? ` · ${failCount} skipped` : ""}`,
      summary: {
        total: employeeIds.length,
        succeeded: successCount,
        failed: failCount,
        totalUnits,
      },
      results: perEmployeeResults,
    });
  } catch (err) {
    console.error("add-employees-batch error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while adding employees",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE A PERSON'S MPC INFORMATION ON A LIVE PO
// ═══════════════════════════════════════════════════════════════════════════════
// Person-wise (measurement_conversion) POs only. Lets sales edit, on an order
// that may already be in production:
//   • the person's identity  — name / UIN / department / designation / gender
//   • the person's product assignment — swap a product, change qty, add or drop
//     a product entirely.
//
// A product-assignment edit has to fan out across every downstream document,
// because each one denormalises the person→product→qty triple:
//     EmployeeMpc.products            (the person master)
//     Measurement.employeeMeasurements[].products   (the MPC sheet)
//     CustomerRequest.items[].variants[].quantity   (PO line quantities)
//     CustomerRequest.quotations[0].items[]         (priced quotation lines)
//     WorkOrder.quantity + rawMaterials + estimatedCost
//     EmployeeProductionProgress   (per-person unit range on each WO)
//
// Nothing here is allowed to invalidate work the shop floor has already done:
// units that are completed, packaged or dispatched pin the range and a change
// that would strand them is rejected with an explicit reason rather than
// silently clamped.
// ─────────────────────────────────────────────────────────────────────────────

const prodKey = (productId, variantId) =>
  `${productId?.toString()}::${variantId ? variantId.toString() : "noVar"}`;

const attrsMatchLoose = (a = [], b = []) => {
  if (!a?.length || !b?.length) return false;
  if (a.length !== b.length) return false;
  return a.every((x) => b.some((y) => y.name === x.name && y.value === x.value));
};

// Raw materials on a WO are a BOM snapshot scaled to the WO quantity. When the
// quantity moves, rescale from the per-unit figures implied by the old quantity
// so the store's allocation targets stay consistent.
function rescaleWorkOrderRawMaterials(wo, oldQty) {
  const newQty = wo.quantity;
  if (wo.rawMaterials?.length && oldQty > 0 && newQty !== oldQty) {
    for (const rm of wo.rawMaterials) {
      const perUnitRequired = (rm.requiredQuantity || 0) / oldQty;
      const perUnitQty = (rm.quantityRequired || 0) / oldQty;
      const perUnitCost = (rm.totalCost || 0) / oldQty;
      rm.requiredQuantity = parseFloat((perUnitRequired * newQty).toFixed(4));
      rm.quantityRequired = parseFloat((perUnitQty * newQty).toFixed(4));
      rm.totalCost = parseFloat((perUnitCost * newQty).toFixed(2));
    }
  }
  wo.estimatedCost = (wo.rawMaterials || []).reduce((s, rm) => s + (rm.totalCost || 0), 0);
}

const barcodesFor = (woNumber, unitStart, unitEnd) => {
  const out = [];
  for (let u = unitStart; u <= unitEnd; u++) out.push(`${woNumber}-${u.toString().padStart(3, "0")}`);
  return out;
};

// Re-plan one person's unit range on a WO to `newQty`.
//   shrink — keep unitStart, pull unitEnd in. Refuses if a completed or
//            packaged unit sits beyond the new end. Leaves a numbering gap,
//            which is harmless: unit numbers are labels, not a dense sequence.
//   grow   — extend in place when the person already owns the tail of the WO;
//            otherwise relocate the whole range to the tail, which is only safe
//            while no unit of theirs has been touched.
function replanUnitRange(progress, newQty, woMaxUnitEnd, woNumber) {
  const oldQty = progress.totalUnits || 0;
  if (newQty === oldQty) return { ok: true, changed: false, maxUnitEnd: woMaxUnitEnd };

  const completedMax = Math.max(0, ...(progress.completedUnitNumbers || [0]));
  const packaged = progress.packagedUnits || 0;

  if (newQty < oldQty) {
    const newEnd = progress.unitStart + newQty - 1;
    if (completedMax > newEnd) {
      return { ok: false, reason: `unit ${completedMax} is already completed — cannot reduce below ${completedMax - progress.unitStart + 1}` };
    }
    if (packaged > newQty) {
      return { ok: false, reason: `${packaged} unit(s) already packaged — cannot reduce below ${packaged}` };
    }
    progress.unitEnd = newEnd;
    progress.totalUnits = newQty;
  } else {
    if (progress.unitEnd === woMaxUnitEnd) {
      progress.unitEnd = progress.unitStart + newQty - 1;
      progress.totalUnits = newQty;
      woMaxUnitEnd = progress.unitEnd;
    } else if ((progress.completedUnits || 0) === 0 && packaged === 0 && !progress.isDispatched) {
      progress.unitStart = woMaxUnitEnd + 1;
      progress.unitEnd = woMaxUnitEnd + newQty;
      progress.totalUnits = newQty;
      woMaxUnitEnd = progress.unitEnd;
    } else {
      return { ok: false, reason: "units are already in production and sit mid-sequence — increase not possible without re-planning the work order" };
    }
  }

  progress.assignedBarcodeIds = barcodesFor(woNumber, progress.unitStart, progress.unitEnd);
  progress.completionPercentage = progress.totalUnits > 0
    ? Math.min(100, Math.round(((progress.completedUnits || 0) / progress.totalUnits) * 100))
    : 0;
  progress.isFullyPackaged = (progress.packagedUnits || 0) >= progress.totalUnits;
  return { ok: true, changed: true, maxUnitEnd: woMaxUnitEnd };
}

// Build a work order for a single product/variant that the PO did not carry
// before. Same shape as the ones createWorkOrdersAndProgress emits, so the
// shop floor cannot tell them apart.
async function createWorkOrderForVariant(request, stockItem, variantData, quantity, userId) {
  const operations = (stockItem.operations || []).map((op) => ({
    operationType: op.type || op.name || op.operationType,
    operationCode: op.operationCode || op.code || "",
    plannedTimeSeconds: op.totalSeconds || op.durationSeconds || 0,
    status: "pending",
  }));

  const rawMaterials = (variantData.rawItems || []).map((rawItem) => ({
    rawItemId: rawItem.rawItemId,
    name: rawItem.rawItemName,
    sku: rawItem.rawItemSku,
    rawItemVariantId: rawItem.variantId || null,
    rawItemVariantCombination: rawItem.variantCombination || [],
    requiredQuantity: (rawItem.requiredQuantity ?? rawItem.quantity ?? 0) * quantity,
    allowancePercent: rawItem.allowancePercent || 0,
    quantityRequired: (rawItem.quantity || 0) * quantity,
    quantityAllocated: 0,
    quantityIssued: 0,
    unit: rawItem.unit,
    unitCost: rawItem.unitCost,
    totalCost: (rawItem.totalCost || 0) * quantity,
    allocationStatus: "not_allocated",
  }));

  const workOrder = new WorkOrder({
    customerRequestId: request._id,
    stockItemId: stockItem._id,
    stockItemName: stockItem.name,
    stockItemReference: stockItem.reference || "",
    variantId: variantData._id.toString(),
    variantAttributes: variantData.attributes || [],
    quantity,
    customerId: request.customerId,
    customerName: request.customerInfo?.name,
    priority: request.priority,
    status: "pending",
    operations,
    rawMaterials,
    timeline: {
      plannedStartDate: null, plannedEndDate: null, actualStartDate: null,
      actualEndDate: null, scheduledStartDate: null, scheduledEndDate: null,
    },
    specialInstructions: [],
    estimatedCost: rawMaterials.reduce((t, rm) => t + (rm.totalCost || 0), 0),
    actualCost: 0,
    createdBy: userId,
  });
  await workOrder.save();
  return workOrder;
}

// Rebuild the quotation's priced lines from the (already updated) request items,
// then roll the totals up onto the request. Mirrors the arithmetic in
// POST /requests/:requestId/quotation so both paths agree to the paisa.
async function recalcQuotationFromRequestItems(request) {
  const quotation = request.quotations?.[0];
  if (!quotation) return null;

  const before = quotation.grandTotal || 0;
  // Lines opened at zero because the catalogue carries no price for that
  // product. Reported back so the merchandiser is told to set a rate rather
  // than shipping a quotation with a free garment on it.
  const unpricedItems = [];

  // A product that has just joined the PO has no priced line yet — open one at
  // the catalogue rate so the customer sees what they are being charged.
  for (const item of request.items) {
    const pid = (item.stockItemId?._id || item.stockItemId)?.toString();
    const hasLine = (quotation.items || []).some(
      (qi) => (qi.stockItemId?._id || qi.stockItemId)?.toString() === pid
    );
    if (hasLine) continue;

    const stockItem = await StockItem.findById(pid).select("name reference hsnCode baseSalesPrice quantityOnHand status").lean();
    const unitPrice = Number(stockItem?.baseSalesPrice) || 0;
    if (unitPrice <= 0) unpricedItems.push(item.stockItemName || stockItem?.name || "product");
    quotation.items.push({
      stockItemId: item.stockItemId?._id || item.stockItemId,
      itemName: item.stockItemName || stockItem?.name || "",
      itemCode: item.stockItemReference || stockItem?.reference || "",
      hsnCode: stockItem?.hsnCode || "",
      description: "",
      quantity: item.totalQuantity || 0,
      unitPrice,
      discountPercentage: 0,
      discountAmount: 0,
      gstPercentage: getGSTPercentage(unitPrice),
      attributes: item.variants?.[0]?.attributes || [],
      stockInfo: { quantityOnHand: stockItem?.quantityOnHand || 0, status: stockItem?.status || "Unknown" },
    });
  }

  const countByStockItem = new Map();
  for (const qi of quotation.items || []) {
    const pid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
    countByStockItem.set(pid, (countByStockItem.get(pid) || 0) + 1);
  }

  for (const qi of quotation.items || []) {
    const pid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
    const reqItem = request.items.find(
      (i) => (i.stockItemId?._id || i.stockItemId)?.toString() === pid
    );
    if (!reqItem) { qi.quantity = 0; continue; }

    // One quotation line per product → it carries the product's whole quantity.
    // Several lines (size/colour split) → match the line back to its variant.
    if (countByStockItem.get(pid) === 1) {
      qi.quantity = reqItem.totalQuantity || 0;
    } else {
      const variant = (reqItem.variants || []).find((v) => attrsMatchLoose(qi.attributes, v.attributes));
      if (variant) qi.quantity = variant.quantity || 0;
    }

    const unitPrice = parseFloat(qi.unitPrice) || 0;
    const gstPercentage = qi.gstPercentage != null ? parseFloat(qi.gstPercentage) : getGSTPercentage(unitPrice);
    const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(qi.quantity, unitPrice, gstPercentage);
    const discountPercentage = parseFloat(qi.discountPercentage) || 0;
    const discountAmount = priceBeforeGST * (discountPercentage / 100);
    const discountedBase = priceBeforeGST - discountAmount;
    const discountedGST = discountedBase * (gstPercentage / 100);

    qi.gstPercentage = gstPercentage;
    qi.discountAmount = parseFloat(discountAmount.toFixed(2));
    qi.priceBeforeGST = discountPercentage > 0 ? parseFloat(discountedBase.toFixed(2)) : priceBeforeGST;
    qi.gstAmount = discountPercentage > 0 ? parseFloat(discountedGST.toFixed(2)) : gstAmount;
    qi.priceIncludingGST = discountPercentage > 0 ? parseFloat((discountedBase + discountedGST).toFixed(2)) : priceIncludingGST;
  }

  quotation.items = (quotation.items || []).filter((qi) => (qi.quantity || 0) > 0);

  const subtotalBeforeGST = quotation.items.reduce((s, i) => s + (i.priceBeforeGST || 0), 0);
  const totalDiscount = quotation.items.reduce((s, i) => s + (i.discountAmount || 0), 0);
  const totalGST = quotation.items.reduce((s, i) => s + (i.gstAmount || 0), 0);
  const shipping = parseFloat(quotation.shippingCharges) || 0;
  const customTotal = (quotation.customAdditionalCharges || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const grandTotal = subtotalBeforeGST + totalGST + shipping + customTotal;

  quotation.subtotalBeforeGST = parseFloat(subtotalBeforeGST.toFixed(2));
  quotation.totalDiscount = parseFloat(totalDiscount.toFixed(2));
  quotation.totalGST = parseFloat(totalGST.toFixed(2));
  quotation.grandTotal = parseFloat(grandTotal.toFixed(2));
  quotation.updatedAt = new Date();

  request.taxSummary = { totalGST, sgst: totalGST / 2, cgst: totalGST / 2, igst: 0 };
  request.finalOrderPrice = quotation.grandTotal;

  // Shrinking an order the customer has already paid for can drive the balance
  // below zero, and `totalDueAmount` is `min: 0` — writing the negative throws a
  // validation error that aborts the entire change and rolls the edit back. The
  // balance is clamped and the excess reported separately as a credit, so the
  // money owed back is surfaced rather than quietly rounded away.
  const rawDue = quotation.grandTotal - (request.totalPaidAmount || 0);
  request.totalDueAmount = parseFloat(Math.max(0, rawDue).toFixed(2));
  const overpaid = rawDue < 0 ? parseFloat(Math.abs(rawDue).toFixed(2)) : 0;

  return { before: parseFloat(before.toFixed(2)), after: quotation.grandTotal, unpricedItems, overpaid };
}

// What the change modal needs to render: the person as they stand today, plus
// the products they can be moved onto — those already on this PO first (no new
// work order needed), then the rest of the catalogue.
router.get("/requests/:requestId/person/:employeeId/edit-context", async (req, res) => {
  try {
    const { requestId, employeeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId) || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const request = await CustomerRequest.findById(requestId).lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Available only for person-wise (measurement) POs" });
    }

    const measurement = await Measurement.findById(request.measurementId).select("employeeMeasurements organizationId").lean();
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    const entry = (measurement.employeeMeasurements || []).find((e) => e.employeeId?.toString() === employeeId);
    if (!entry) return res.status(404).json({ success: false, message: "Person is not part of this PO" });

    const mpc = await EmployeeMpc.findById(employeeId).lean();

    const poStockItemIds = (request.items || []).map((i) => (i.stockItemId?._id || i.stockItemId)?.toString()).filter(Boolean);
    const poSet = new Set(poStockItemIds);

    const stockItems = await StockItem.find({})
      .select("name reference hsnCode genderCategory baseSalesPrice images additionalNames variants")
      .lean();

    // The picker shows a thumbnail, the gender category and any alias the product
    // is known by, so a merchandiser can tell two same-named garments apart —
    // "Modi Jacket (Female)" and "Modi Jacket (Male)" are different work orders.
    const firstImage = (s) =>
      s.images?.[0] || (s.variants || []).map((v) => v.images?.[0]).find(Boolean) || null;

    const catalogue = stockItems.map((s) => ({
      _id: s._id,
      name: s.name,
      reference: s.reference || "",
      genderCategory: s.genderCategory || "",
      baseSalesPrice: s.baseSalesPrice || 0,
      image: firstImage(s),
      aliases: (s.additionalNames || [])
        .map((a) => (typeof a === "string" ? a : a?.name))
        .filter(Boolean),
      inPO: poSet.has(s._id.toString()),
      variants: (s.variants || []).map((v) => ({
        variantId: v._id,
        sku: v.sku || "",
        attributes: v.attributes || [],
        image: v.images?.[0] || null,
      })),
    }));
    catalogue.sort((a, b) => (b.inPO ? 1 : 0) - (a.inPO ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));

    // Per-product production state — the modal greys out what can no longer move.
    const progressDocs = await EmployeeProductionProgress.find({
      manufacturingOrderId: request._id,
      employeeId,
    }).lean();
    const workOrders = await WorkOrder.find({ customerRequestId: request._id })
      .select("_id workOrderNumber stockItemId variantId status quantity")
      .lean();
    const woById = new Map(workOrders.map((w) => [w._id.toString(), w]));

    const productionByKey = {};
    for (const p of progressDocs) {
      const wo = woById.get(p.workOrderId?.toString());
      if (!wo) continue;
      productionByKey[prodKey(wo.stockItemId, wo.variantId)] = {
        workOrderNumber: wo.workOrderNumber,
        workOrderStatus: wo.status,
        unitStart: p.unitStart,
        unitEnd: p.unitEnd,
        totalUnits: p.totalUnits,
        completedUnits: p.completedUnits || 0,
        packagedUnits: p.packagedUnits || 0,
        isDispatched: !!p.isDispatched,
      };
    }

    res.json({
      success: true,
      person: {
        employeeId,
        name: mpc?.name ?? entry.employeeName,
        uin: mpc?.uin ?? entry.employeeUIN,
        gender: mpc?.gender ?? entry.gender,
        department: mpc?.department || "",
        designation: mpc?.designation || "",
      },
      products: (entry.products || []).map((p) => ({
        key: prodKey(p.productId, p.variantId),
        productId: p.productId?.toString() || null,
        productName: p.productName || "",
        variantId: p.variantId?.toString() || null,
        quantity: p.quantity || 1,
        production: productionByKey[prodKey(p.productId, p.variantId)] || null,
      })),
      catalogue,
      hasWorkOrders: workOrders.length > 0,
    });
  } catch (err) {
    console.error("person edit-context error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

router.put("/requests/:requestId/person/:employeeId", async (req, res) => {
  try {
    const { requestId, employeeId } = req.params;
    const { person, products } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(requestId) || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    if (!person && !Array.isArray(products)) {
      return res.status(400).json({ success: false, message: "Nothing to change — send `person` and/or `products`" });
    }

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Available only for person-wise (measurement) POs" });
    }

    const measurement = await Measurement.findById(request.measurementId);
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    const entry = (measurement.employeeMeasurements || []).find((e) => e.employeeId?.toString() === employeeId);
    if (!entry) return res.status(404).json({ success: false, message: "Person is not part of this PO" });

    const mpc = await EmployeeMpc.findById(employeeId);
    if (!mpc) return res.status(404).json({ success: false, message: "Employee master record not found" });

    const personChanges = [];
    const productChanges = [];
    const blocked = [];

    // ── 1. Identity ─────────────────────────────────────────────────────────
    if (person && typeof person === "object") {
      const trim = (v) => (typeof v === "string" ? v.trim() : v);

      if (person.uin !== undefined && trim(person.uin) && trim(person.uin).toUpperCase() !== (mpc.uin || "")) {
        const clash = await EmployeeMpc.findOne({
          _id: { $ne: mpc._id },
          customerId: mpc.customerId,
          uin: trim(person.uin).toUpperCase(),
        }).select("_id name").lean();
        if (clash) {
          return res.status(409).json({
            success: false,
            message: `UIN ${trim(person.uin).toUpperCase()} already belongs to ${clash.name} in this organisation`,
          });
        }
      }

      for (const field of ["name", "uin", "gender", "department", "designation"]) {
        if (person[field] === undefined) continue;
        const next = trim(person[field]);
        if (field === "gender" && next && !["Male", "Female"].includes(next)) {
          return res.status(400).json({ success: false, message: "gender must be Male or Female" });
        }
        if ((field === "name" || field === "uin" || field === "gender") && !next) continue; // required-ish: don't blank out
        const prev = mpc[field] || "";
        mpc[field] = next;
        if ((mpc[field] || "") !== prev) personChanges.push({ field, from: prev, to: mpc[field] || "" });
      }
    }

    // ── 2. Product assignment ───────────────────────────────────────────────
    let priceMovement = null;
    let itemsTouched = false;

    if (Array.isArray(products)) {
      const desired = new Map();
      for (const raw of products) {
        const pid = (raw?.productId || "").toString();
        if (!mongoose.Types.ObjectId.isValid(pid)) {
          return res.status(400).json({ success: false, message: `Invalid productId: ${pid}` });
        }
        const qty = Number(raw.quantity);
        if (!Number.isInteger(qty) || qty < 1) {
          return res.status(400).json({ success: false, message: "Each product needs an integer quantity of at least 1" });
        }
        const vid = raw.variantId && mongoose.Types.ObjectId.isValid(raw.variantId) ? raw.variantId.toString() : null;
        const k = prodKey(pid, vid);
        // Same product+variant listed twice — fold the quantities together.
        const existing = desired.get(k);
        desired.set(k, {
          productId: pid,
          variantId: vid,
          quantity: (existing?.quantity || 0) + qty,
          productName: (raw.productName || existing?.productName || "").trim(),
        });
      }

      const current = new Map();
      for (const p of entry.products || []) {
        if (!p.productId) continue;
        current.set(prodKey(p.productId, p.variantId), p);
      }

      const allWOs = await WorkOrder.find({ customerRequestId: request._id });
      const hasWorkOrders = allWOs.length > 0;
      const touchedWOs = new Map(); // id -> qty before this request
      const woMaxUnit = new Map();  // id -> highest unitEnd currently allocated

      const loadWoMaxUnit = async (wo) => {
        const id = wo._id.toString();
        if (woMaxUnit.has(id)) return woMaxUnit.get(id);
        const last = await EmployeeProductionProgress.find({ workOrderId: wo._id })
          .select("unitEnd").sort({ unitEnd: -1 }).limit(1).lean();
        const max = last[0]?.unitEnd || 0;
        woMaxUnit.set(id, max);
        return max;
      };

      const markTouched = (wo) => {
        const id = wo._id.toString();
        if (!touchedWOs.has(id)) touchedWOs.set(id, wo.quantity || 0);
      };

      const DEAD_WO_STATUSES = ["completed", "cancelled", "forwarded"];

      // `liveOnly` matters when units are being ADDED. Emptying a work order
      // cancels it rather than deleting it, so a person who is swapped off a
      // product and later swapped back would otherwise match that dead order and
      // be refused forever. Hiding dead orders from a pure addition lets a fresh
      // one be created instead. Reductions still see every order, so an existing
      // progress row is always found and reported against honestly.
      const findWO = (pid, vid, { liveOnly = false } = {}) => {
        const pool = liveOnly ? allWOs.filter((w) => !DEAD_WO_STATUSES.includes(w.status)) : allWOs;
        const byVariant = vid ? pool.find((w) => w.stockItemId?.toString() === pid && w.variantId === vid) : null;
        if (byVariant) return byVariant;
        return pool.find((w) => w.stockItemId?.toString() === pid) || null;
      };

      // Request item + variant this person's units land on. Creates the item /
      // variant when the person is being moved onto a product the PO doesn't
      // carry yet.
      const resolveRequestSlot = async (pid, vid, wo) => {
        let item = request.items.find((i) => (i.stockItemId?._id || i.stockItemId)?.toString() === pid);
        let stockItem = null;

        if (!item) {
          stockItem = await StockItem.findById(pid);
          if (!stockItem) return { error: "Product not found in catalogue" };
          item = {
            stockItemId: stockItem._id,
            stockItemName: stockItem.name,
            stockItemReference: stockItem.reference || "",
            variants: [],
            totalQuantity: 0,
            totalEstimatedPrice: 0,
          };
          request.items.push(item);
          item = request.items[request.items.length - 1];
        }

        let variant = null;
        if (vid) variant = (item.variants || []).find((v) => v.variantId?.toString() === vid);
        if (!variant && wo?.variantAttributes?.length) {
          variant = (item.variants || []).find((v) => attrsMatchLoose(wo.variantAttributes, v.attributes));
        }
        if (!variant && !vid && item.variants?.length) variant = item.variants[0];

        // A brand-new variant line has no price history to divide, so seed the
        // per-unit rate from the catalogue.
        let unitPriceHint = 0;
        if (!variant) {
          if (!stockItem) stockItem = await StockItem.findById(pid);
          const sv = vid ? (stockItem?.variants || []).find((v) => v._id.toString() === vid) : (stockItem?.variants || [])[0];
          unitPriceHint = Number(stockItem?.baseSalesPrice) || 0;
          item.variants.push({
            variantId: sv?._id || vid || null,
            attributes: sv?.attributes || [],
            quantity: 0,
            specialInstructions: [],
            estimatedPrice: 0,
          });
          variant = item.variants[item.variants.length - 1];
        }

        return { item, variant, unitPriceHint };
      };

      const keys = new Set([...current.keys(), ...desired.keys()]);

      for (const key of keys) {
        const now = current.get(key);
        const next = desired.get(key);
        const oldQty = now?.quantity || 0;
        const newQty = next?.quantity || 0;
        const pid = (next?.productId || now?.productId)?.toString();
        const vid = next?.variantId || now?.variantId?.toString() || null;
        const label = next?.productName || now?.productName || "product";

        if (oldQty === newQty) {
          if (now && next?.productName && next.productName !== now.productName) now.productName = next.productName;
          continue;
        }

        const delta = newQty - oldQty;
        let wo = hasWorkOrders ? findWO(pid, vid, { liveOnly: oldQty === 0 }) : null;

        // Moving somebody onto a product this PO has never carried, on an order
        // that is already on the shop floor: the product needs a work order of
        // its own or the units would be invisible to production.
        let woIsNew = false;
        if (!wo && hasWorkOrders && newQty > 0) {
          const stockItem = await StockItem.findById(pid);
          if (!stockItem) { blocked.push({ key, product: label, reason: "product not found in catalogue" }); continue; }
          const variantData = (vid && stockItem.variants?.find((v) => v._id.toString() === vid)) || stockItem.variants?.[0];
          if (!variantData) { blocked.push({ key, product: label, reason: "product has no variant to manufacture" }); continue; }
          // Built at the final quantity, so its BOM snapshot is scaled correctly
          // from the outset — the delta pass below must therefore skip it.
          wo = await createWorkOrderForVariant(request, stockItem, variantData, newQty, req.user?.id);
          allWOs.push(wo);
          woIsNew = true;
        }

        // ── Guard rails on the work order ──────────────────────────────────
        if (wo) {
          if (["completed", "cancelled", "forwarded"].includes(wo.status)) {
            blocked.push({ key, product: label, reason: `work order ${wo.workOrderNumber} is ${wo.status}` });
            continue;
          }
          const projected = (wo.quantity || 0) + delta;
          if (projected < (wo.packagedQuantity || 0) || projected < (wo.dispatchedQuantity || 0)) {
            blocked.push({ key, product: label, reason: `work order ${wo.workOrderNumber} already has packaged/dispatched units above the new quantity` });
            continue;
          }
        }

        // ── Production progress for this person on this WO ──────────────────
        let progress = null;
        if (wo) {
          progress = await EmployeeProductionProgress.findOne({ workOrderId: wo._id, employeeId: mpc._id });
        }

        if (newQty === 0) {
          if (progress) {
            if ((progress.completedUnits || 0) > 0 || (progress.packagedUnits || 0) > 0 || progress.isDispatched) {
              blocked.push({ key, product: label, reason: "units are already completed / packaged / dispatched — cannot remove" });
              continue;
            }
            await EmployeeProductionProgress.deleteOne({ _id: progress._id });
          }
        } else if (progress) {
          const max = await loadWoMaxUnit(wo);
          const outcome = replanUnitRange(progress, newQty, max, wo.workOrderNumber);
          if (!outcome.ok) { blocked.push({ key, product: label, reason: outcome.reason }); continue; }
          woMaxUnit.set(wo._id.toString(), outcome.maxUnitEnd);
          await progress.save();
        } else if (wo) {
          // New product for this person on an existing WO — take the tail.
          const max = await loadWoMaxUnit(wo);
          const unitStart = max + 1;
          const unitEnd = max + newQty;
          woMaxUnit.set(wo._id.toString(), unitEnd);
          await EmployeeProductionProgress.findOneAndUpdate(
            { workOrderId: wo._id, employeeId: mpc._id },
            {
              $set: {
                measurementId: measurement._id,
                manufacturingOrderId: request._id,
                employeeName: mpc.name,
                employeeUIN: mpc.uin,
                gender: mpc.gender,
                unitStart, unitEnd, totalUnits: newQty,
                assignedBarcodeIds: barcodesFor(wo.workOrderNumber, unitStart, unitEnd),
                completedUnits: 0, completedUnitNumbers: [], completionPercentage: 0,
                lastSyncedAt: new Date(),
              },
            },
            { upsert: true, new: true }
          );
        }

        // ── Work order quantity ────────────────────────────────────────────
        if (wo && !woIsNew) {
          markTouched(wo);
          wo.quantity = (wo.quantity || 0) + delta;
        }

        // ── Request item / variant quantity + estimated price ───────────────
        const slot = await resolveRequestSlot(pid, vid, wo);
        if (slot.error) { blocked.push({ key, product: label, reason: slot.error }); continue; }
        const { item, variant, unitPriceHint } = slot;

        const beforeVariantQty = variant.quantity || 0;
        const perUnitPrice = beforeVariantQty > 0 && variant.estimatedPrice
          ? variant.estimatedPrice / beforeVariantQty
          : unitPriceHint;

        variant.quantity = beforeVariantQty + delta;
        item.totalQuantity = (item.totalQuantity || 0) + delta;

        const newVariantPrice = parseFloat((perUnitPrice * variant.quantity).toFixed(2));
        item.totalEstimatedPrice = parseFloat(
          (((item.totalEstimatedPrice || 0) - (variant.estimatedPrice || 0)) + newVariantPrice).toFixed(2)
        );
        variant.estimatedPrice = newVariantPrice;
        itemsTouched = true;

        // A variant that no longer carries any units is dead weight on the PO.
        if (variant.quantity <= 0) {
          item.variants = (item.variants || []).filter((v) => v !== variant && (v.quantity || 0) > 0);
        }

        productChanges.push({ product: label, from: oldQty, to: newQty, workOrder: wo?.workOrderNumber || null });
      }

      // Drop request items that ended up with nothing on them.
      request.items = request.items.filter((i) => (i.totalQuantity || 0) > 0 && (i.variants || []).length > 0);

      // ── Apply the accepted changes to the two person-level records ───────
      // A blocked line keeps whatever it had before, so the person record can
      // never drift away from the work orders that were actually adjusted.
      const blockedKeys = new Set(blocked.map((b) => b.key));
      const finalProducts = [];
      for (const [key, want] of desired) {
        if (blockedKeys.has(key)) {
          const keep = current.get(key);
          if (keep) finalProducts.push(keep);
          continue;
        }
        finalProducts.push({
          productId: want.productId,
          variantId: want.variantId,
          quantity: want.quantity,
          productName: want.productName,
        });
      }
      // Anything blocked from removal has to stay on the person.
      for (const [key, had] of current) {
        if (desired.has(key)) continue;
        if (blockedKeys.has(key)) finalProducts.push(had);
      }

      mpc.products = finalProducts.map((p) => ({
        productId: p.productId,
        variantId: p.variantId || undefined,
        quantity: p.quantity,
        productName: p.productName || "",
      }));

      entry.products = finalProducts.map((p) => {
        const prior = current.get(prodKey(p.productId, p.variantId));
        return {
          productId: p.productId,
          productName: p.productName || prior?.productName || "",
          variantId: p.variantId || null,
          variantName: prior?.variantName || "Default",
          quantity: p.quantity,
          // Measurements taken against this product survive a pure quantity
          // change; a swap to a different product legitimately starts blank.
          measurements: prior?.measurements || [],
          measuredAt: prior?.measuredAt || new Date(),
          qrGenerated: prior?.qrGenerated || false,
          templateId: prior?.templateId,
          templateName: prior?.templateName,
        };
      });
      entry.noProductAssigned = entry.products.length === 0;

      // ── Persist the touched work orders ─────────────────────────────────
      for (const [woId, oldQty] of touchedWOs) {
        const wo = allWOs.find((w) => w._id.toString() === woId);
        if (!wo) continue;
        if (wo.quantity <= 0) {
          // Nobody is left on this work order — retire it rather than leaving a
          // zero-quantity order on the shop floor. `status: "cancelled"` is what
          // every other reader of a WorkOrder actually checks to know it's dead
          // (see the guard a few lines up: `["completed","cancelled","forwarded"]`)
          // — the schema's own `quantity: { min: 1 }` means the field can never
          // legitimately hold 0, cancelled or not, so the last real quantity is
          // kept as a record of what this order was for rather than zeroed out.
          // `oldQty` is safe as a floor here: it was read from an already-saved
          // WorkOrder, which the same schema constraint guarantees was >= 1.
          await EmployeeProductionProgress.deleteMany({ workOrderId: wo._id });
          wo.status = "cancelled";
          wo.quantity = oldQty > 0 ? oldQty : 1;
        } else {
          rescaleWorkOrderRawMaterials(wo, oldQty);
        }
        await wo.save();
      }
    }

    // ── 3. Push identity onto the denormalised copies ───────────────────────
    if (personChanges.length) {
      entry.employeeName = mpc.name;
      entry.employeeUIN = mpc.uin;
      entry.gender = mpc.gender;
      await EmployeeProductionProgress.updateMany(
        { manufacturingOrderId: request._id, employeeId: mpc._id },
        { $set: { employeeName: mpc.name, employeeUIN: mpc.uin, gender: mpc.gender } }
      );
    }

    // ── 4. Re-price ─────────────────────────────────────────────────────────
    if (itemsTouched) priceMovement = await recalcQuotationFromRequestItems(request);

    await mpc.save();
    measurement.markModified("employeeMeasurements");
    await measurement.save();
    request.markModified("items");
    if (itemsTouched) request.markModified("quotations");
    request.updatedBy = req.user?.id;
    request.updatedAt = new Date();
    await request.save();

    const parts = [];
    if (personChanges.length) parts.push(`${personChanges.length} detail(s) updated`);
    if (productChanges.length) parts.push(`${productChanges.length} product change(s) applied`);
    if (blocked.length) parts.push(`${blocked.length} blocked`);

    res.json({
      success: true,
      message: parts.length ? parts.join(" · ") : "No changes were needed",
      personChanges,
      productChanges,
      blocked,
      priceMovement,
    });
  } catch (err) {
    console.error("change person error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while changing the person's information",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

router.put("/payment-submissions/:submissionId/status", async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { status, verificationNotes } = req.body;
    if (!["pending", "verified", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be one of pending, verified, rejected" });
    }
    if (status === "rejected" && !String(verificationNotes || "").trim()) {
      return res.status(400).json({ success: false, message: "A reason is required when rejecting a payment" });
    }
    const request = await CustomerRequest.findOne({ 'quotations.paymentSubmissions._id': submissionId });
    if (!request) return res.status(404).json({ success: false, message: "Payment submission not found" });
    const quotation = request.quotations.find(q => q.paymentSubmissions.some(s => s._id.toString() === submissionId));
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    const submission = quotation.paymentSubmissions.id(submissionId);
    if (!submission) return res.status(404).json({ success: false, message: "Payment submission not found" });

    const previousStatus = submission.status;
    submission.status = status; submission.verifiedBy = req.user.id; submission.verifiedAt = new Date();
    if (verificationNotes) submission.verificationNotes = verificationNotes;
    submission.updatedAt = new Date();

    const paymentStep = quotation.paymentSchedule.find(p => p.stepNumber === submission.paymentStepNumber);
    if (paymentStep) {
      if (status === 'verified' && previousStatus !== 'verified') {
        paymentStep.paidAmount = (paymentStep.paidAmount || 0) + submission.submittedAmount;
        paymentStep.paidDate = new Date();
        // The customer-submission route intentionally leaves these alone until
        // now — this is the ONE place a payment actually becomes "paid" on the
        // request, gated on a sales person confirming it.
        request.totalPaidAmount = (request.totalPaidAmount || 0) + submission.submittedAmount;
        request.totalDueAmount = quotation.grandTotal - request.totalPaidAmount;
        request.lastPaymentDate = new Date();
      } else if (previousStatus === 'verified' && status !== 'verified') {
        paymentStep.paidAmount = Math.max(0, (paymentStep.paidAmount || 0) - submission.submittedAmount);
        request.totalPaidAmount = Math.max(0, (request.totalPaidAmount || 0) - submission.submittedAmount);
        request.totalDueAmount = quotation.grandTotal - request.totalPaidAmount;
      }
      if (paymentStep.paidAmount >= paymentStep.amount) paymentStep.status = 'paid';
      else if (paymentStep.paidAmount > 0) paymentStep.status = 'partially_paid';
      else paymentStep.status = 'pending';
    }
    request.updatedAt = new Date();

    // Mirror the decision into the notification feed so the customer portal can
    // show "payment approved / rejected by sales" rather than silence.
    request.quotationNotifications = request.quotationNotifications || [];
    request.quotationNotifications.push({
      type: status === "verified" ? "payment_verified" : status === "rejected" ? "payment_rejected" : "payment_received",
      message: `Payment of ₹${submission.submittedAmount} for ${paymentStep?.name || `Step ${submission.paymentStepNumber}`} was ${status === "verified" ? "approved" : status} by ${req.user?.name || "Sales Team"}${verificationNotes ? ` — ${verificationNotes}` : ""}.`,
      relatedId: submission._id,
      actionRequired: false,
      createdAt: new Date(),
    });

    request.notes = request.notes || [];
    request.notes.push({
      text: `Payment submission of ₹${submission.submittedAmount} for ${paymentStep?.name || `Step ${submission.paymentStepNumber}`} marked ${status}${verificationNotes ? ` — ${verificationNotes}` : ""}.`,
      addedBy: req.user.id,
      addedByModel: "SalesDepartment",
      createdAt: new Date(),
    });
    await request.save();
    res.json({ success: true, message: "Payment submission status updated", submission, request });
  } catch (error) {
    console.error("Error updating payment submission:", error);
    res.status(500).json({ success: false, message: "Server error while updating payment submission" });
  }
});

router.get("/requests/:requestId/payment-submissions", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(404).json({ success: false, message: "No quotation found" });
    res.json({ success: true, submissions: request.quotations[0].paymentSubmissions || [] });
  } catch (error) {
    console.error("Error fetching payment submissions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching payment submissions" });
  }
});

router.post("/requests/:requestId/quotation/send", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found to send" });
    const quotation = request.quotations[0];
    // A rejected quotation may be re-sent after the sales person revises it —
    // otherwise a single customer rejection dead-ends the request forever.
    if (!['draft', 'rejected', 'expired'].includes(quotation.status)) {
      return res.status(400).json({ success: false, message: `Quotation is already '${quotation.status}' and cannot be re-sent` });
    }
    quotation.status = 'sent_to_customer'; quotation.sentToCustomerAt = new Date(); quotation.sentBy = req.user.id; quotation.updatedAt = new Date();
    syncRequestStatusFromQuotation(request, quotation); request.updatedAt = new Date();
    request.quotationNotifications.push({ type: 'customer_approval', message: 'Quotation sent to customer for approval', actionRequired: false, createdAt: new Date() });
    await request.save();
    try { await CustomerEmailService.sendQuotationEmail(request, quotation, req.user); } catch (emailError) { console.error("Failed to send quotation email:", emailError); }
    res.json({ success: true, message: "Quotation sent to customer successfully", request });
  } catch (error) {
    console.error("Error sending quotation:", error);
    res.status(500).json({ success: false, message: "Server error while sending quotation" });
  }
});

router.get("/requests/:requestId/quotation/:quotationId/payment-submissions", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(req.params.quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    const submissions = quotation.paymentSubmissions || [];
    submissions.sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate));
    res.json({ success: true, submissions, count: submissions.length });
  } catch (error) {
    console.error("Error fetching payment submissions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching payment submissions" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPER — WO + EmployeeProductionProgress creation
// Used by both sales-approve and mark-internal-order
// ═══════════════════════════════════════════════════════════════════════════════
async function createWorkOrdersAndProgress(request, userId) {
  const isMeasurementOrder = !!(request.requestType === "measurement_conversion" || request.measurementId);
  const orderType = isMeasurementOrder ? "measurement_conversion" : "customer_request";

  let measurement = null;
  if (isMeasurementOrder && request.measurementId) {
    measurement = await Measurement.findById(request.measurementId)
      .select("_id employeeMeasurements")
      .lean();
  }

  // Measurement-PO orders: WOs get created here, one per stockItem/variant in
  // request.items — but request.items was built at convert-to-po time by
  // dumping every person onto whichever variant they already had (defaulting
  // to stockItem.variants[0], "any random/common variant" per the product
  // owner). That means every WO — and its BOM snapshot — got created against
  // the WRONG size. Re-resolve the real per-person variant via the Settings
  // size config right here, BEFORE any WO exists, so the WO itself (not just
  // a later display) is correct. request.items itself (pricing/summary,
  // already saved to the customer) is left untouched — only the LOCAL loop
  // below uses the corrected breakdown.
  let effectiveItems = request.items;
  let employeeVariantMap = null;
  if (isMeasurementOrder && request.measurementId) {
    try {
      const resolved = await resolveMeasurementRequestItems(request);
      if (resolved.items?.length) {
        effectiveItems = resolved.items;
        employeeVariantMap = resolved.employeeVariantMap;
      }
    } catch (resolveErr) {
      console.error("[createWorkOrdersAndProgress] Measurement size-config resolution (non-fatal):", resolveErr.message);
    }
  }

  const createdWorkOrders = [];
  const skippedVariants = [];
  const createdProgressDocs = [];

  for (const item of effectiveItems) {
    const stockItem = await StockItem.findById(item.stockItemId);
    if (!stockItem) { console.warn(`StockItem not found: ${item.stockItemId}`); continue; }

    for (const variant of item.variants) {
      let variantData = null;
      let usedFallback = false;

      if (variant.variantId && mongoose.Types.ObjectId.isValid(variant.variantId)) {
        variantData = stockItem.variants.find(v => v._id.toString() === variant.variantId);
      }
      if (!variantData && variant.attributes?.length > 0) {
        variantData = stockItem.variants.find(v => {
          if (!v.attributes || v.attributes.length !== variant.attributes.length) return false;
          return variant.attributes.every(reqAttr => {
            const stockAttr = v.attributes.find(a => a.name === reqAttr.name);
            return stockAttr && stockAttr.value === reqAttr.value;
          });
        });
      }
      if (!variantData && variant.variantId) {
        variantData = stockItem.variants.find(v => v.sku === variant.variantId);
      }
      if (!variantData && stockItem.variants?.length > 0) {
        variantData = stockItem.variants[0];
        usedFallback = true;
        skippedVariants.push({ productName: stockItem.name, originalVariantId: variant.variantId, selectedVariant: { id: variantData._id, sku: variantData.sku } });
      }
      if (!variantData) {
        skippedVariants.push({ productName: stockItem.name, originalVariantId: variant.variantId, error: "No variants available" });
        continue;
      }

      const operations = stockItem.operations.map(op => ({
        operationType: op.type || op.name || op.operationType,
        operationCode: op.operationCode || op.code || "",
        plannedTimeSeconds: op.totalSeconds || op.durationSeconds || 0,
        status: "pending",
      }));

      let rawMaterials = [];
      if (variantData.rawItems?.length > 0) {
        rawMaterials = variantData.rawItems.map(rawItem => ({
          rawItemId: rawItem.rawItemId, name: rawItem.rawItemName, sku: rawItem.rawItemSku,
          rawItemVariantId: rawItem.variantId || null,
          rawItemVariantCombination: rawItem.variantCombination || [],
          // BOM-line breakdown, scaled the same way as quantityRequired — lets
          // the WO-scoped raw-item-requirement view show the allowance % too.
          requiredQuantity: (rawItem.requiredQuantity ?? rawItem.quantity ?? 0) * variant.quantity,
          allowancePercent: rawItem.allowancePercent || 0,
          quantityRequired: rawItem.quantity * variant.quantity,
          quantityAllocated: 0, quantityIssued: 0,
          unit: rawItem.unit, unitCost: rawItem.unitCost,
          totalCost: rawItem.totalCost * variant.quantity,
          allocationStatus: "not_allocated",
        }));
      }

      const variantAttributes = variant.attributes || [];
      if (variantAttributes.length === 0 && variantData.attributes) variantAttributes.push(...variantData.attributes);

      const workOrder = new WorkOrder({
        customerRequestId: request._id, stockItemId: item.stockItemId,
        stockItemName: item.stockItemName, stockItemReference: item.stockItemReference,
        variantId: variantData._id.toString(), variantAttributes,
        quantity: variant.quantity, customerId: request.customerId,
        customerName: request.customerInfo.name, priority: request.priority,
        status: "pending", operations, rawMaterials,
        timeline: { plannedStartDate: null, plannedEndDate: null, actualStartDate: null, actualEndDate: null, scheduledStartDate: null, scheduledEndDate: null },
        specialInstructions: variant.specialInstructions || [],
        estimatedCost: rawMaterials.reduce((total, rm) => total + (rm.totalCost || 0), 0),
        actualCost: 0, createdBy: userId,
      });
      await workOrder.save();

      createdWorkOrders.push({
        _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber,
        stockItemName: workOrder.stockItemName, stockItemId: item.stockItemId,
        variantId: variantData._id.toString(),
        quantity: workOrder.quantity, rawMaterialCount: workOrder.rawMaterials.length,
        autoSelectedVariant: usedFallback,
      });

      if (isMeasurementOrder && measurement) {
        const stockIdStr = item.stockItemId.toString();
        const woVariantIdStr = variantData._id.toString();
        const employeeEntries = [];

        for (const empM of measurement.employeeMeasurements || []) {
          // Prefer the size-config resolution's own map — it knows each
          // person's REAL resolved variant. Falls back to the old
          // productId/variantId heuristic only when resolution didn't run
          // (e.g. no size config exists yet for this product).
          let productEntry;
          if (employeeVariantMap) {
            const resolvedVariantId = employeeVariantMap.get(`${empM.employeeId?.toString()}_${stockIdStr}`);
            if (resolvedVariantId !== woVariantIdStr) continue;
            productEntry = (empM.products || []).find(p => {
              const pIdMatch = p.productId?.toString() === stockIdStr;
              return pIdMatch || (!p.productId && p.productName === item.stockItemName);
            });
          } else {
            productEntry = (empM.products || []).find(p => {
              const pIdMatch = p.productId?.toString() === stockIdStr;
              if (!pIdMatch) {
                if (p.productId) return false;
                if (p.productName !== item.stockItemName) return false;
                if (woVariantIdStr && p.variantId) return p.variantId.toString() === woVariantIdStr;
                return true;
              }
              if (woVariantIdStr && p.variantId) return p.variantId.toString() === woVariantIdStr;
              if (woVariantIdStr && !p.variantId) return p.productName === item.stockItemName;
              return true;
            });
          }
          if (!productEntry) continue;
          employeeEntries.push({
            employeeId: empM.employeeId, employeeName: empM.employeeName,
            employeeUIN: empM.employeeUIN, gender: empM.gender,
            quantity: productEntry.quantity || variant.quantity,
          });
        }

        if (employeeEntries.length > 0) {
          const woNumber = workOrder.workOrderNumber;
          let unitCursor = 1;
          for (const emp of employeeEntries) {
            const unitStart = unitCursor;
            const unitEnd = unitCursor + emp.quantity - 1;
            const assignedBarcodeIds = [];
            for (let u = unitStart; u <= unitEnd; u++) {
              assignedBarcodeIds.push(`${woNumber}-${u.toString().padStart(3, "0")}`);
            }
            try {
              await EmployeeProductionProgress.findOneAndUpdate(
                { workOrderId: workOrder._id, employeeId: emp.employeeId },
                {
                  $set: {
                    measurementId: measurement._id, manufacturingOrderId: request._id,
                    orderType, employeeName: emp.employeeName, employeeUIN: emp.employeeUIN,
                    gender: emp.gender, unitStart, unitEnd, totalUnits: emp.quantity,
                    assignedBarcodeIds, completedUnits: 0, completedUnitNumbers: [],
                    completionPercentage: 0, lastSyncedAt: new Date(),
                  },
                },
                { upsert: true, new: true }
              );
              createdProgressDocs.push({
                employeeName: emp.employeeName, employeeUIN: emp.employeeUIN,
                productName: workOrder.stockItemName, unitStart, unitEnd,
                totalUnits: emp.quantity, barcodeCount: assignedBarcodeIds.length,
              });
            } catch (progressErr) {
              console.error(`[createWorkOrdersAndProgress] Progress error for ${emp.employeeName}:`, progressErr.message);
            }
            unitCursor = unitEnd + 1;
          }
        }
      }
    }
  }

  return { createdWorkOrders, skippedVariants, createdProgressDocs };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SALES APPROVAL — now delegates WO creation to shared helper
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/requests/:requestId/quotation/sales-approve", async (req, res) => {
  try {
    const { requestId } = req.params;
    // acknowledgeNoCustomerApproval — the sales person has been shown the
    // "no customer approval, no advance payment" warning and chose to push the
    // order to production anyway. Payment is deliberately NOT a precondition
    // here: recording money is a separate flow (record-payment / verify).
    const { notes, acknowledgeNoCustomerApproval } = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found for this request" });

    const quotation = request.quotations[0];
    const approvedWithoutCustomer =
      quotation.status === "sent_to_customer" && !!acknowledgeNoCustomerApproval;

    if (quotation.status !== "customer_approved" && !approvedWithoutCustomer) {
      return res.status(400).json({
        success: false,
        message: quotation.status === "sent_to_customer"
          ? "Quotation is not approved by the customer yet. Re-send with acknowledgeNoCustomerApproval to approve on their behalf."
          : `Quotation cannot be approved from status '${quotation.status}'`,
      });
    }

    if (approvedWithoutCustomer) {
      // Record the implicit customer approval so both portals show a complete,
      // honest trail rather than an order that jumped a step.
      quotation.customerApproval = {
        approved: true,
        approvedAt: new Date(),
        approvedBy: null,
        notes: `Approved by sales (${req.user?.name || "Sales Team"}) without customer approval or advance payment.`,
      };
      request.notes = request.notes || [];
      request.notes.push({
        text: `Quotation pushed to production by ${req.user?.name || "Sales Team"} without customer approval or advance payment.${notes ? ` Reason: ${notes}` : ""}`,
        addedBy: req.user.id,
        addedByModel: "SalesDepartment",
        createdAt: new Date(),
      });
    }

    quotation.status = "sales_approved";
    quotation.salesApproval = { approved: true, approvedAt: new Date(), approvedBy: req.user.id, notes: notes || "" };
    quotation.updatedAt = new Date();
    syncRequestStatusFromQuotation(request, quotation);
    request.finalOrderPrice = quotation.grandTotal;
    request.totalDueAmount = Math.max(0, quotation.grandTotal - (request.totalPaidAmount || 0));
    request.updatedAt = new Date();
    request.quotationNotifications = request.quotationNotifications.filter(n => n.type !== "sales_approval_required");

    const { createdWorkOrders, skippedVariants, createdProgressDocs } = await createWorkOrdersAndProgress(request, req.user.id);

    await request.save();

    let msg = createdWorkOrders.length > 0
      ? `Quotation approved and ${createdWorkOrders.length} work order(s) created`
      : "Quotation approved but no work orders were created";
    if (createdProgressDocs.length > 0) msg += `. ${createdProgressDocs.length} employee tracking record(s) created.`;

    try {
      await CustomerEmailService.sendSalesApprovalEmail(request, quotation);
    } catch (emailErr) {
      console.error("[sales-approve] Approval notification email failed:", emailErr.message);
    }

    res.json({
      success: true, message: msg, request, createdWorkOrders,
      skippedVariants: skippedVariants.length > 0 ? skippedVariants : undefined,
      employeeTrackingCreated: createdProgressDocs.length,
    });
  } catch (error) {
    console.error("Error processing sales approval:", error);
    res.status(500).json({ success: false, message: "Server error while processing approval" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL / COMPANY ORDER — bypass PI, go directly to production
// ═══════════════════════════════════════════════════════════════════════════════
router.patch("/requests/:requestId/mark-internal-order", async (req, res) => {
  try {
    const { requestId } = req.params;

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Only pending requests can be marked as internal orders" });

    // Mark as internal
    request.isInternalOrder = true;
    request.internalOrderMarkedAt = new Date();

    // Minimal pre-approved quotation — no monetary value
    request.quotations = [{
      date: new Date(),
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      items: [],
      subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0, shippingCharges: 0, grandTotal: 0,
      status: "sales_approved",
      notes: "Internal / Company Order — no PI or payment required.",
      customerApproval: { approved: true, approvedAt: new Date() },
      salesApproval: { approved: true, approvedAt: new Date(), approvedBy: req.user.id },
    }];

    request.status = "quotation_sales_approved";
    request.finalOrderPrice = 0;
    if (!request.salesPersonAssigned) request.salesPersonAssigned = req.user.id;

    // Run the exact same WO + employee progress creation as a normal sales-approve
    const { createdWorkOrders, skippedVariants, createdProgressDocs } = await createWorkOrdersAndProgress(request, req.user.id);

    request.notes = request.notes || [];
    request.notes.push({
      text: `Marked as Internal Order (no PI required). ${createdWorkOrders.length} work order(s) created directly for production.`,
      addedBy: req.user.id,
      addedByModel: "SalesDepartment",
      createdAt: new Date(),
    });
    request.updatedAt = new Date();
    await request.save();

    let msg = `Internal Order approved. ${createdWorkOrders.length} work order(s) sent to production`;
    if (createdProgressDocs.length > 0) msg += `. ${createdProgressDocs.length} employee tracking record(s) created.`;

    res.json({
      success: true, message: msg, request, createdWorkOrders,
      skippedVariants: skippedVariants.length > 0 ? skippedVariants : undefined,
      employeeTrackingCreated: createdProgressDocs.length,
    });
  } catch (error) {
    console.error("Error marking internal order:", error);
    res.status(500).json({ success: false, message: "Server error while marking internal order" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ADD EMPLOYEE TO MEASUREMENT-PO  (NEW)
//
// Two endpoints:
//   GET  /requests/:requestId/search-employees-for-add?query=...
//   POST /requests/:requestId/add-employee  { employeeId }
//
// The POST cascades through:
//   1. Measurement.employeeMeasurements  → push entry (empty measurement values)
//   2. CustomerRequest.items[].variants[].quantity → increment per matched product
//   3. WorkOrder.quantity + rawMaterials proportional update
//   4. EmployeeProductionProgress → create new doc with appended unit range
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/requests/:requestId/search-employees-for-add", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { query = "" } = req.query;

    if (!query || query.trim().length < 2) {
      return res.json({ success: true, results: [] });
    }
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }

    const request = await CustomerRequest.findById(requestId)
      .select("customerId measurementId requestType")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Available only for measurement POs" });
    }

    const measurement = await Measurement.findById(request.measurementId)
      .select("organizationId employeeMeasurements")
      .lean();
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    // Already-added IDs to filter out
    const existingEmpIds = new Set(
      (measurement.employeeMeasurements || [])
        .map((e) => e.employeeId?.toString())
        .filter(Boolean)
    );

    const re = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const employees = await EmployeeMpc.find({
      customerId: measurement.organizationId,
      status: "active",
      $or: [{ uin: re }, { name: re }],
    })
      .populate("products.productId", "name reference genderCategory")
      .limit(15)
      .lean();

    const results = employees
      .filter((e) => !existingEmpIds.has(e._id.toString()))
      .map((e) => ({
        employeeId: e._id,
        name: e.name,
        uin: e.uin,
        gender: e.gender,
        department: e.department || "",
        designation: e.designation || "",
        productCount: (e.products || []).length,
        products: (e.products || []).map((p) => ({
          productId: (p.productId?._id || p.productId)?.toString(),
          productName:
            p.productName?.trim() || p.productId?.name || "Unknown",
          variantId: p.variantId?.toString() || null,
          quantity: p.quantity || 1,
        })),
      }));

    res.json({ success: true, results });
  } catch (err) {
    console.error("search-employees-for-add error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

router.post("/requests/:requestId/add-employee", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { employeeId } = req.body;

    if (
      !mongoose.Types.ObjectId.isValid(requestId) ||
      !mongoose.Types.ObjectId.isValid(employeeId)
    ) {
      return res.status(400).json({ success: false, message: "Invalid IDs" });
    }

    // ── 1. Load resources ────────────────────────────────────────────────
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.requestType !== "measurement_conversion" || !request.measurementId) {
      return res.status(400).json({ success: false, message: "Only available for measurement POs" });
    }

    const employee = await EmployeeMpc.findById(employeeId)
      .populate("products.productId", "name reference")
      .lean();
    if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
    if (!employee.products || employee.products.length === 0) {
      return res.status(400).json({ success: false, message: "Employee has no products assigned" });
    }

    const measurement = await Measurement.findById(request.measurementId);
    if (!measurement) return res.status(404).json({ success: false, message: "Measurement not found" });

    // Belongs to same org?
    if (measurement.organizationId.toString() !== employee.customerId?.toString()) {
      return res.status(400).json({
        success: false,
        message: "Employee is not part of this organization",
      });
    }

    // Already added?
    const alreadyExists = (measurement.employeeMeasurements || []).some(
      (e) => e.employeeId?.toString() === employeeId.toString()
    );
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Employee already added to this PO" });
    }

    // ── 2. For each product the employee has, find matching item + WO ────
    const woUpdates = [];                  // { wo, reqItem, reqVariant, qty }
    const productsToAddToMeasurement = []; // entries pushed into measurement.employeeMeasurements
    const newProgressDocsToCreate = [];    // queued doc creations
    const skippedProducts = [];

    for (const empProd of employee.products) {
      const empProdId = (empProd.productId?._id || empProd.productId)?.toString();
      const empVariantId = empProd.variantId?.toString() || null;
      const qty = empProd.quantity || 1;
      const empProdName =
        empProd.productName?.trim() || empProd.productId?.name || "Unknown";

      if (!empProdId) {
        skippedProducts.push({ productName: empProdName, reason: "Missing productId" });
        continue;
      }

      // Locate the item in request.items by stockItemId
      const reqItem = request.items.find((it) => {
        const iid = (it.stockItemId?._id || it.stockItemId)?.toString();
        return iid === empProdId;
      });
      if (!reqItem) {
        skippedProducts.push({ productName: empProdName, reason: "Product not in this PO" });
        continue;
      }

      // Locate matching WO (by stockItemId + variantId if possible)
      const candidateWOs = await WorkOrder.find({
        customerRequestId: request._id,
        stockItemId: reqItem.stockItemId,
      });

      let matchingWO = null;
      if (empVariantId) {
        matchingWO = candidateWOs.find((w) => w.variantId === empVariantId);
      }
      if (!matchingWO && candidateWOs.length === 1) {
        // single variant — safe fallback
        matchingWO = candidateWOs[0];
      }
      if (!matchingWO && candidateWOs.length > 0) {
        // multiple WOs but no variant match — pick first as last resort
        matchingWO = candidateWOs[0];
      }

      if (!matchingWO) {
        skippedProducts.push({ productName: empProdName, reason: "No matching work order found" });
        continue;
      }

      // Block if WO is already past production
      const blockedStatuses = ["completed", "cancelled", "forwarded"];
      if (blockedStatuses.includes(matchingWO.status)) {
        skippedProducts.push({
          productName: empProdName,
          reason: `Work order is ${matchingWO.status} — cannot extend`,
        });
        continue;
      }

      // Find which variant on reqItem corresponds to this WO
      let reqVariant = null;
      if (empVariantId) {
        reqVariant = reqItem.variants.find(
          (v) => v.variantId && v.variantId.toString() === empVariantId
        );
      }
      if (!reqVariant) {
        // Match by attributes against WO's variantAttributes
        if (matchingWO.variantAttributes?.length) {
          reqVariant = reqItem.variants.find((v) => {
            if (!v.attributes || v.attributes.length === 0) return false;
            return matchingWO.variantAttributes.every((wa) =>
              v.attributes.find((a) => a.name === wa.name && a.value === wa.value)
            );
          });
        }
      }
      if (!reqVariant && reqItem.variants.length === 1) reqVariant = reqItem.variants[0];
      if (!reqVariant && reqItem.variants.length > 0) reqVariant = reqItem.variants[0];

      if (!reqVariant) {
        skippedProducts.push({ productName: empProdName, reason: "No variant entry to extend" });
        continue;
      }

      // Compute next unit range for new progress doc
      const lastProgress = await EmployeeProductionProgress.find({
        workOrderId: matchingWO._id,
      })
        .select("unitEnd")
        .sort({ unitEnd: -1 })
        .limit(1)
        .lean();
      const currentMaxUnit = lastProgress[0]?.unitEnd || 0;
      const unitStart = currentMaxUnit + 1;
      const unitEnd = currentMaxUnit + qty;

      const woNumber = matchingWO.workOrderNumber;
      const assignedBarcodeIds = [];
      for (let u = unitStart; u <= unitEnd; u++) {
        assignedBarcodeIds.push(`${woNumber}-${u.toString().padStart(3, "0")}`);
      }

      woUpdates.push({ wo: matchingWO, reqItem, reqVariant, qty });

      newProgressDocsToCreate.push({
        workOrderId: matchingWO._id,
        manufacturingOrderId: request._id,
        measurementId: measurement._id,
        orderType: "measurement_conversion",
        employeeId: employee._id,
        employeeName: employee.name,
        employeeUIN: employee.uin,
        gender: employee.gender,
        unitStart,
        unitEnd,
        totalUnits: qty,
        assignedBarcodeIds,
        productName: empProdName,
      });

      productsToAddToMeasurement.push({
        productId: empProd.productId?._id || empProd.productId,
        productName: empProdName,
        variantId: empProd.variantId || null,
        variantName: "Default",
        quantity: qty,
        measurements: [], // empty — user fills in via measurement edit later
        measuredAt: new Date(),
        qrGenerated: false,
        qrGeneratedAt: null,
      });
    }

    if (woUpdates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No products could be added — all skipped",
        skippedProducts,
      });
    }

    // ── 3. Apply WO updates: quantity, rawMaterials proportional, cost ──
    for (const u of woUpdates) {
      const oldWOQty = u.wo.quantity || 0;
      u.wo.quantity = oldWOQty + u.qty;

      if (u.wo.rawMaterials && u.wo.rawMaterials.length > 0 && oldWOQty > 0) {
        for (const rm of u.wo.rawMaterials) {
          const perUnitQty = (rm.quantityRequired || 0) / oldWOQty;
          const perUnitCost = (rm.totalCost || 0) / oldWOQty;
          rm.quantityRequired = parseFloat((perUnitQty * u.wo.quantity).toFixed(4));
          rm.totalCost = parseFloat((perUnitCost * u.wo.quantity).toFixed(2));
        }
      }
      u.wo.estimatedCost = (u.wo.rawMaterials || []).reduce(
        (s, rm) => s + (rm.totalCost || 0),
        0
      );
      await u.wo.save();

      // ── 4. Update request item totals ───────────────────────────────
      const oldVariantQty = u.reqVariant.quantity || 0;
      u.reqVariant.quantity = oldVariantQty + u.qty;
      u.reqItem.totalQuantity = (u.reqItem.totalQuantity || 0) + u.qty;

      if (oldVariantQty > 0 && u.reqVariant.estimatedPrice) {
        const perUnitPrice = u.reqVariant.estimatedPrice / oldVariantQty;
        const newVariantPrice = perUnitPrice * u.reqVariant.quantity;
        const priceDelta = newVariantPrice - u.reqVariant.estimatedPrice;
        u.reqVariant.estimatedPrice = parseFloat(newVariantPrice.toFixed(2));
        u.reqItem.totalEstimatedPrice = parseFloat(
          ((u.reqItem.totalEstimatedPrice || 0) + priceDelta).toFixed(2)
        );
      }
    }

    // ── 5. Push to measurement.employeeMeasurements ──────────────────
    measurement.employeeMeasurements.push({
      employeeId: employee._id,
      employeeName: employee.name,
      employeeUIN: employee.uin,
      gender: employee.gender,
      products: productsToAddToMeasurement,
      noProductAssigned: false,
      categoryMeasurements: [],
      isCompleted: false,
      remarks: "",
    });

    measurement.totalRegisteredEmployees =
      (measurement.totalRegisteredEmployees || 0) + 1;
    measurement.pendingEmployees = (measurement.pendingEmployees || 0) + 1;

    if (
      !(measurement.registeredEmployeeIds || []).some(
        (id) => id.toString() === employee._id.toString()
      )
    ) {
      measurement.registeredEmployeeIds = measurement.registeredEmployeeIds || [];
      measurement.registeredEmployeeIds.push(employee._id);
    }
    if (
      !(measurement.poCreatedForEmployeeIds || []).some(
        (id) => id.toString() === employee._id.toString()
      )
    ) {
      measurement.poCreatedForEmployeeIds = measurement.poCreatedForEmployeeIds || [];
      measurement.poCreatedForEmployeeIds.push(employee._id);
    }

    await measurement.save();

    // ── 6. Save the request ──────────────────────────────────────────
    request.markModified("items");
    request.updatedAt = new Date();
    await request.save();

    // ── 7. Create progress docs ──────────────────────────────────────
    const createdProgressDetails = [];
    for (const pd of newProgressDocsToCreate) {
      try {
        await EmployeeProductionProgress.findOneAndUpdate(
          { workOrderId: pd.workOrderId, employeeId: pd.employeeId },
          {
            $set: {
              measurementId: pd.measurementId,
              manufacturingOrderId: pd.manufacturingOrderId,
              orderType: pd.orderType,
              employeeName: pd.employeeName,
              employeeUIN: pd.employeeUIN,
              gender: pd.gender,
              unitStart: pd.unitStart,
              unitEnd: pd.unitEnd,
              totalUnits: pd.totalUnits,
              assignedBarcodeIds: pd.assignedBarcodeIds,
              completedUnits: 0,
              completedUnitNumbers: [],
              completionPercentage: 0,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true, new: true }
        );
        createdProgressDetails.push({
          productName: pd.productName,
          unitStart: pd.unitStart,
          unitEnd: pd.unitEnd,
          totalUnits: pd.totalUnits,
        });
      } catch (progressErr) {
        console.error(
          `[add-employee] Progress doc error for ${pd.employeeName} on WO ${pd.workOrderId}:`,
          progressErr.message
        );
      }
    }

    res.json({
      success: true,
      message: `${employee.name} added · ${createdProgressDetails.length} product(s) · ${createdProgressDetails.reduce((s, p) => s + p.totalUnits, 0)} unit(s)`,
      added: {
        employee: { name: employee.name, uin: employee.uin, gender: employee.gender },
        productCount: createdProgressDetails.length,
        totalUnits: createdProgressDetails.reduce((s, p) => s + p.totalUnits, 0),
        details: createdProgressDetails,
      },
      skippedProducts: skippedProducts.length > 0 ? skippedProducts : undefined,
    });
  } catch (err) {
    console.error("add-employee error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while adding employee",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});


// ── Existing endpoints below ─────────────────────────────────────────────────

router.get('/:measurementId/po-persons-export', async (req, res) => {
  try {
    const { measurementId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(measurementId)) {
      return res.status(400).json({ success: false, message: 'Valid measurement ID required' });
    }
    const measurement = await Measurement.findById(measurementId)
      .populate({ path: 'employeeMeasurements.products.productId', select: '_id name' })
      .lean();
    if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

    const empIds = measurement.employeeMeasurements.map(e => e.employeeId).filter(Boolean);
    const mpcEmployees = await EmployeeMpc.find({ _id: { $in: empIds } })
      .select('_id products department designation')
      .lean();

    const mpcNameMap = new Map();
    const mpcDetailsMap = new Map();
    mpcEmployees.forEach(emp => {
      const eid = emp._id.toString();
      mpcDetailsMap.set(eid, { department: emp.department || '', designation: emp.designation || '' });
      const prodMap = new Map();
      (emp.products || []).forEach(p => {
        const pid = p.productId?.toString();
        if (pid && p.productName?.trim()) prodMap.set(pid, p.productName.trim());
      });
      mpcNameMap.set(eid, prodMap);
    });

    const headers = ['#', 'Employee Name', 'UIN', 'Gender', 'Department', 'Designation', 'Products'];
    const rows = measurement.employeeMeasurements.map((emp, idx) => {
      const eid = emp.employeeId?.toString();
      const mpcDets = mpcDetailsMap.get(eid) || {};
      const prodMap = mpcNameMap.get(eid) || new Map();
      const productsStr = (emp.products || []).map(p => {
        const pid = (p.productId?._id || p.productId)?.toString();
        const displayName = (pid && prodMap.get(pid)) || p.productName || p.productId?.name || 'Unknown';
        return `${displayName} x${p.quantity || 1}`;
      }).join(' | ');
      return [
        idx + 1, `"${emp.employeeName || ''}"`, emp.employeeUIN || '', emp.gender || '',
        `"${mpcDets.department || ''}"`, `"${mpcDets.designation || ''}"`, `"${productsStr}"`,
      ].join(',');
    });

    const csv = ['\uFEFF', headers.join(','), ...rows].join('\n');
    const safeName = (measurement.name || 'measurement').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_persons.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('po-persons-export error:', error);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});


router.post("/requests/:requestId/quotation/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found" });
    const quotation = request.quotations[0];
    if (quotation.status === 'sales_approved') {
      return res.status(400).json({ success: false, message: "A sales-approved quotation cannot be rejected — cancel the order instead" });
    }
    const wasCustomerApproved = quotation.status === 'customer_approved';
    quotation.status = 'rejected'; quotation.updatedAt = new Date();
    quotation.salesApproval = { approved: false, approvedAt: new Date(), approvedBy: req.user.id, notes: reason || 'Rejected by sales team' };
    // A rejected quotation always parks the request back at in_progress so it
    // reads the same on both portals — previously it claimed 'quotation_sent'
    // while the quotation itself said 'rejected'.
    syncRequestStatusFromQuotation(request, quotation);
    request.updatedAt = new Date();
    request.notes = request.notes || [];
    request.notes.push({
      text: `Quotation ${wasCustomerApproved ? "rejected after customer approval" : "rejected"} by ${req.user?.name || "Sales Team"}. Reason: ${reason || "—"}`,
      addedBy: req.user.id, addedByModel: "SalesDepartment", createdAt: new Date(),
    });
    request.quotationNotifications.push({ type: 'quotation_expired', message: `Quotation rejected: ${reason}`, actionRequired: false });
    await request.save();
    res.json({ success: true, message: "Quotation rejected", request });
  } catch (error) {
    console.error("Error rejecting quotation:", error);
    res.status(500).json({ success: false, message: "Server error while rejecting quotation" });
  }
});

router.get("/requests/:requestId/quotations/:quotationId", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(req.params.quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    res.json({ success: true, quotation });
  } catch (error) {
    console.error("Error fetching quotation:", error);
    res.status(500).json({ success: false, message: "Server error while fetching quotation" });
  }
});

router.get("/requests/:requestId/quotations", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    res.json({ success: true, quotations: request.quotations });
  } catch (error) {
    console.error("Error fetching quotations:", error);
    res.status(500).json({ success: false, message: "Server error while fetching quotations" });
  }
});

router.get("/requests/:requestId/quotations/:quotationId/download", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const quotation = request.quotations.id(req.params.quotationId);
    if (!quotation) return res.status(404).json({ success: false, message: "Quotation not found" });
    res.json({ success: true, quotation, request: { requestId: request.requestId, customerInfo: request.customerInfo } });
  } catch (error) {
    console.error("Error fetching quotation for download:", error);
    res.status(500).json({ success: false, message: "Server error while fetching quotation" });
  }
});


router.delete("/requests/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    if (request.measurementId) {
      await Measurement.findByIdAndUpdate(request.measurementId, {
        $set: {
          convertedToPO: false, poRequestId: null, poConversionDate: null,
          convertedBy: null, poCreatedForEmployeeIds: [],
        },
      });
    }
    if (WorkOrder) await WorkOrder.deleteMany({ customerRequestId: request._id });
    await CustomerRequest.findByIdAndDelete(requestId);

    res.json({ success: true, message: "PO/Quotation removed successfully", measurementReset: !!request.measurementId });
  } catch (error) {
    console.error("Error deleting request:", error);
    res.status(500).json({ success: false, message: "Server error while removing PO/Quotation" });
  }
});


router.post("/requests/:requestId/quotation/approve-on-behalf", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { approvalNotes, customerInfoOverride, payment, poProof } = req.body;

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    if (request.quotations.length === 0)
      return res.status(400).json({ success: false, message: "No quotation found for this request" });

    const quotation = request.quotations[0];

    // Allow on-behalf approval only when the quotation is sent_to_customer
    if (!["sent_to_customer", "draft"].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot approve on behalf — quotation is already '${quotation.status}'`,
      });
    }

    // ── THE CUSTOMER'S PO IS THE EVIDENCE, AND IT IS REQUIRED ───────────────
    // (25 Aug 2026, explicit request.) This route records that a customer
    // approved a price, while acting as Sales — an assertion about someone
    // who is not here, which until now took nothing but a click. The PO is
    // the document the customer actually sent, so it is what makes the claim
    // checkable afterwards.
    //
    // Enforced HERE and not only by disabling the button: a disabled button
    // is a courtesy, not a control, and this endpoint is reachable without
    // the UI. An upload with no usable address is rejected too — a record
    // pointing at nothing is worse than an honest refusal, because it reads
    // as evidence on every screen that lists it.
    const poFile = poProof && (poProof.url || poProof.fileId || poProof.publicId) ? poProof : null;
    if (!poFile) {
      return res.status(400).json({
        success: false,
        message: "Upload the customer's PO before recording their approval — it is the proof of what they agreed to.",
        code: "PO_PROOF_REQUIRED",
      });
    }
    quotation.poProof = {
      fileId: poFile.fileId || undefined,
      publicId: poFile.publicId || undefined,
      url: poFile.url || undefined,
      name: poFile.name || undefined,
      mimeType: poFile.mimeType || undefined,
      poNumber: poFile.poNumber ? String(poFile.poNumber).trim() : undefined,
      poDate: poFile.poDate ? new Date(poFile.poDate) : undefined,
      poValue: Number.isFinite(Number(poFile.poValue)) && Number(poFile.poValue) >= 0
        ? Number(poFile.poValue)
        : undefined,
      uploadedAt: new Date(),
      uploadedBy: req.user?.id || undefined,
    };

    // 1. Mark customer approval
    quotation.customerApproval = {
      approved:   true,
      approvedAt: new Date(),
      approvedBy: null, // no customer ObjectId since sales is acting on behalf
      notes:      approvalNotes
        ? `[On Behalf by Sales] ${approvalNotes}`
        : `Approved on behalf of customer by ${req.user?.name || "Sales Team"}`,
    };
    quotation.status     = "customer_approved";
    quotation.updatedAt  = new Date();

    // 2. Update request status (projection of the quotation status)
    syncRequestStatusFromQuotation(request, quotation);
 
    // 3. Update customer info if overrides provided
    if (customerInfoOverride) {
      if (customerInfoOverride.address)
        request.customerInfo.address = customerInfoOverride.address;
      if (customerInfoOverride.city)
        request.customerInfo.city = customerInfoOverride.city;
      if (customerInfoOverride.postalCode)
        request.customerInfo.postalCode = customerInfoOverride.postalCode;
      if (customerInfoOverride.deliveryDeadline)
        request.customerInfo.deliveryDeadline = new Date(customerInfoOverride.deliveryDeadline);
      if (customerInfoOverride.preferredContactMethod)
        request.customerInfo.preferredContactMethod = customerInfoOverride.preferredContactMethod;
      if (customerInfoOverride.description !== undefined)
        request.customerInfo.description = customerInfoOverride.description;
    }
 
    // 4. Record payment submission
    let paymentUpdated = false;
    if (payment && payment.submittedAmount > 0) {
      const submission = {
        paymentStepNumber: payment.paymentStepNumber || 1,
        submissionDate:    new Date(),
        submittedAmount:   Number(payment.submittedAmount),
        paymentMethod:     payment.paymentMethod,
        transactionId:     payment.transactionId || "",
        utrNumber:         payment.utrNumber || "",
        receiptImage:      payment.receiptImage || "",
        additionalNotes:   payment.additionalNotes || "",
        submittedBy:       null,
        status:            "verified",
        verifiedBy:        req.user?.id,
        verifiedAt:        new Date(),
        verificationNotes: `Recorded on behalf of customer by ${req.user?.name || "Sales Team"}`,
        // ── On-behalf audit trail ───────────────────────────────────────
        isOnBehalf:            true,
        onBehalfCustomerName:  request.customerInfo?.name || "",
        recordedByName:        req.user?.name || "Sales Team",
        recordedById:          req.user?.id || null,
        signatoryName:         payment.signatoryName  || "",
        signatoryContact:      payment.signatoryContact || "",
        authorizationNote:     payment.authorizationNote || "",
        digitalSignature:      payment.digitalSignature  || "",
        recordedAt:            payment.recordedAt ? new Date(payment.recordedAt) : new Date(),
      };
 
      quotation.paymentSubmissions = quotation.paymentSubmissions || [];
      quotation.paymentSubmissions.push(submission);
 
      // Update the payment schedule step status
      const step = quotation.paymentSchedule.find(
        (p) => p.stepNumber === submission.paymentStepNumber
      );
      if (step) {
        step.paidAmount = (step.paidAmount || 0) + submission.submittedAmount;
        step.paidDate   = new Date();
        if (step.paidAmount >= step.amount) step.status = "paid";
        else step.status = "partially_paid";
        step.paymentMethod = payment.paymentMethod;
      }
 
      // Update top-level payment tracking
      request.totalPaidAmount  = (request.totalPaidAmount || 0) + submission.submittedAmount;
      request.totalDueAmount   = Math.max(0, (quotation.grandTotal || 0) - request.totalPaidAmount);
      request.lastPaymentDate  = new Date();

      // Surface it on both portals as a verified (sales-recorded) payment.
      request.quotationNotifications = request.quotationNotifications || [];
      request.quotationNotifications.push({
        type: "payment_verified",
        message: `Advance payment of ₹${submission.submittedAmount} recorded on behalf of the customer by ${req.user?.name || "Sales Team"}.`,
        actionRequired: false,
        createdAt: new Date(),
      });

      paymentUpdated = true;
    }
 
    // 5. Add note
    request.notes = request.notes || [];
    request.notes.push({
      text:       `Quotation approved on behalf of customer by ${req.user?.name || "Sales Team"}.${paymentUpdated ? ` Advance payment of ₹${payment.submittedAmount} recorded (${payment.paymentMethod}).` : ""}`,
      addedBy:    req.user?.id,
      addedByModel: "SalesDepartment",
      createdAt:  new Date(),
    });
 
    request.updatedAt = new Date();
    await request.save();
 
    // Notify customer about the payment recorded on their behalf
    if (paymentUpdated) {
      try {
        const lastSubmission = quotation.paymentSubmissions[quotation.paymentSubmissions.length - 1];
        await CustomerEmailService.sendPaymentRecordedEmail(request, quotation, lastSubmission, true);
      } catch (emailErr) {
        console.error("[approve-on-behalf] Payment notification email failed:", emailErr.message);
      }
    }
 
    res.json({
      success: true,
      message: `Quotation approved on behalf of customer.${paymentUpdated ? " Advance payment recorded." : ""}`,
      request,
    });
  } catch (error) {
    console.error("Error in approve-on-behalf:", error);
    res.status(500).json({ success: false, message: "Server error while processing on-behalf approval" });
  }
});
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// RECORD A PAYMENT STEP (sales-side manual recording)
//
// POST /api/cms/sales/requests/:requestId/record-payment
//
// Body:
//   {
//     paymentStepNumber: number,
//     submittedAmount:   number,
//     paymentMethod:     string,
//     transactionId:     string,
//     utrNumber:         string,
//     receiptImage:      string,
//     additionalNotes:   string,
//   }
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/requests/:requestId/record-payment", async (req, res) => {
  try {
    const { requestId } = req.params;
    const {
      paymentStepNumber, submittedAmount, paymentMethod,
      transactionId, utrNumber, receiptImage, additionalNotes,
      signatoryName, signatoryContact, authorizationNote,
      digitalSignature, recordedAt,
      // On-behalf: sales is logging a payment the customer made but could not
      // submit themselves (paid in person, over the phone, by cheque at the
      // office). It is recorded as verified — a sales person entering it IS
      // the verification — but flagged and attributed so the audit trail
      // never pretends the customer filed it.
      isOnBehalf,
    } = req.body;

    if (!submittedAmount || submittedAmount <= 0)
      return res.status(400).json({ success: false, message: "Amount must be greater than zero" });
    if (!paymentMethod)
      return res.status(400).json({ success: false, message: "Payment method is required" });
    if (isOnBehalf && !String(signatoryName || "").trim())
      return res.status(400).json({ success: false, message: "A signatory name is required when recording a payment on behalf of the customer" });

    const request = await CustomerRequest.findById(requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
 
    if (request.quotations.length === 0)
      return res.status(400).json({ success: false, message: "No quotation found for this request" });
 
    const quotation = request.quotations[0];
 
    const submission = {
      paymentStepNumber: paymentStepNumber || 1,
      submissionDate:    new Date(),
      submittedAmount:   Number(submittedAmount),
      paymentMethod,
      transactionId:     transactionId || "",
      utrNumber:         utrNumber || "",
      receiptImage:      receiptImage || "",
      additionalNotes:   additionalNotes || "",
      submittedBy:       null,
      status:            "verified",
      verifiedBy:        req.user?.id,
      verifiedAt:        new Date(),
      verificationNotes: isOnBehalf
        ? `Recorded on behalf of ${request.customerInfo?.name || "the customer"} by ${req.user?.name || "Sales Team"}`
        : `Recorded by sales: ${req.user?.name || "Sales Team"}`,
      // ── Audit trail ──────────────────────────────────────────────────
      isOnBehalf:            !!isOnBehalf,
      onBehalfCustomerName:  request.customerInfo?.name || "",
      recordedByName:        req.user?.name || "Sales Team",
      recordedById:          req.user?.id || null,
      signatoryName:         signatoryName  || "",
      signatoryContact:      signatoryContact || "",
      authorizationNote:     authorizationNote || "",
      digitalSignature:      digitalSignature  || "",
      recordedAt:            recordedAt ? new Date(recordedAt) : new Date(),
    };
 
    quotation.paymentSubmissions = quotation.paymentSubmissions || [];
    quotation.paymentSubmissions.push(submission);
 
    // Update schedule step
    const step = quotation.paymentSchedule.find(
      (p) => p.stepNumber === submission.paymentStepNumber
    );
    if (step) {
      step.paidAmount    = (step.paidAmount || 0) + submission.submittedAmount;
      step.paidDate      = new Date();
      step.paymentMethod = paymentMethod;
      if (step.paidAmount >= step.amount) step.status = "paid";
      else if (step.paidAmount > 0) step.status = "partially_paid";
    }
 
    // Top-level totals
    request.totalPaidAmount = (request.totalPaidAmount || 0) + submission.submittedAmount;
    request.totalDueAmount  = Math.max(0, (quotation.grandTotal || 0) - request.totalPaidAmount);
    request.lastPaymentDate = new Date();

    request.quotationNotifications = request.quotationNotifications || [];
    request.quotationNotifications.push({
      type: "payment_verified",
      message: isOnBehalf
        ? `Payment of ₹${submission.submittedAmount} was recorded on your behalf by ${req.user?.name || "Sales Team"} (${paymentMethod}).`
        : `Payment of ₹${submission.submittedAmount} recorded by ${req.user?.name || "Sales Team"} (${paymentMethod}).`,
      actionRequired: false,
      createdAt: new Date(),
    });

    request.notes = request.notes || [];
    request.notes.push({
      text:         isOnBehalf
        ? `Payment of ₹${submittedAmount} recorded for Step ${paymentStepNumber} on behalf of ${request.customerInfo?.name || "the customer"} by ${req.user?.name || "Sales Team"} (${paymentMethod}). Authorised by ${signatoryName}.`
        : `Payment of ₹${submittedAmount} recorded for Step ${paymentStepNumber} by ${req.user?.name || "Sales Team"} (${paymentMethod}).`,
      addedBy:      req.user?.id,
      addedByModel: "SalesDepartment",
      createdAt:    new Date(),
    });
 
    request.updatedAt = new Date();
    await request.save();
 
    // Notify customer about the payment recorded
    try {
      const lastSubmission = quotation.paymentSubmissions[quotation.paymentSubmissions.length - 1];
      await CustomerEmailService.sendPaymentRecordedEmail(request, quotation, lastSubmission, !!isOnBehalf);
    } catch (emailErr) {
      console.error("[record-payment] Payment notification email failed:", emailErr.message);
    }

    res.json({
      success: true,
      message: isOnBehalf
        ? "Payment recorded on behalf of the customer"
        : "Payment recorded successfully",
      request,
    });
  } catch (error) {
    console.error("Error in record-payment:", error);
    res.status(500).json({ success: false, message: "Server error while recording payment" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /requests/:requestId/po-breakdown
// (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/requests/:requestId/po-breakdown", async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await CustomerRequest.findById(requestId)
      .populate("items.stockItemId", "name genderCategory hsnCode reference")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (!request.quotations || request.quotations.length === 0) return res.status(400).json({ success: false, message: "No quotation found for this request" });

    const quotation = request.quotations[0];
    const isMeasurementPO = request.requestType === "measurement_conversion" && !!request.measurementId;
    if (!isMeasurementPO) return res.json({ success: true, quotation, request });

    const measurement = await Measurement.findById(request.measurementId).select("employeeMeasurements").lean();
    if (!measurement) return res.json({ success: true, quotation, request });

    const empIds = (measurement.employeeMeasurements || []).map((e) => e.employeeId).filter(Boolean);
    const mpcEmployees = await EmployeeMpc.find({ _id: { $in: empIds } }).select("_id products").lean();

    const mpcAliasMap = new Map();
    for (const emp of mpcEmployees) {
      const eid = emp._id.toString();
      const lookup = new Map();
      for (const p of emp.products || []) {
        const pidStr = p.productId?.toString();
        if (!pidStr) continue;
        const vidStr = p.variantId?.toString() || null;
        const alias = (p.productName || "").trim();
        if (!alias) continue;
        if (vidStr) lookup.set(`${pidStr}::${vidStr}`, alias);
        else lookup.set(`${pidStr}::_noVar_`, alias);
        if (!lookup.has(pidStr)) lookup.set(pidStr, alias);
      }
      mpcAliasMap.set(eid, lookup);
    }

    const attrsEqual = (a = [], b = []) => {
      if (a.length !== b.length) return false;
      return a.every((x) => b.some((y) => y.name === x.name && y.value === x.value));
    };

    const bucketMap = new Map();
    for (const empM of measurement.employeeMeasurements || []) {
      const eid = empM.employeeId?.toString();
      const aliasLookup = mpcAliasMap.get(eid) || new Map();
      for (const prod of empM.products || []) {
        const pidStr = prod.productId?.toString();
        if (!pidStr) continue;
        const vidStr = prod.variantId?.toString() || null;
        const qty = Number(prod.quantity) || 0;
        if (qty <= 0) continue;
        const reqItemForGender = request.items.find(i => {
          const iPid = (i.stockItemId?._id || i.stockItemId)?.toString();
          return iPid === pidStr;
        });
        const gender = reqItemForGender?.stockItemId?.genderCategory || "Unisex";
        let aliasName =
          (vidStr && aliasLookup.get(`${pidStr}::${vidStr}`)) ||
          aliasLookup.get(`${pidStr}::_noVar_`) ||
          aliasLookup.get(pidStr) ||
          (prod.productName || "").trim() || "Unknown";
        const bucketKey = `${pidStr}::${vidStr || "noVar"}::${aliasName}::${gender}`;
        if (!bucketMap.has(bucketKey)) {
          const reqItem = request.items.find((i) => {
            const iPid = (i.stockItemId?._id || i.stockItemId)?.toString();
            return iPid === pidStr;
          });
          let reqVariant = null;
          if (reqItem) reqVariant = reqItem.variants?.[0] || null;
          let quotItem = null;
          if (reqItem && reqVariant) {
            quotItem = quotation.items.find((qi) => {
              const qiPid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
              if (qiPid !== pidStr) return false;
              return attrsEqual(qi.attributes || [], reqVariant.attributes || []);
            });
          }
          if (!quotItem) {
            quotItem = quotation.items.find((qi) => {
              const qiPid = (qi.stockItemId?._id || qi.stockItemId)?.toString();
              return qiPid === pidStr;
            });
          }
          const unitPrice = Number(quotItem?.unitPrice) || 0;
          const gstPercentage = quotItem?.gstPercentage != null ? Number(quotItem.gstPercentage) : getGSTPercentage(unitPrice);
          bucketMap.set(bucketKey, {
            stockItemId: pidStr, variantId: vidStr,
            itemName: gender ? `${aliasName} (${gender})` : aliasName,
            itemCode: quotItem?.itemCode || reqItem?.stockItemReference || reqItem?.stockItemId?.reference || "",
            hsnCode: quotItem?.hsnCode || reqItem?.stockItemId?.hsnCode || "",
            gender,
            attributes: reqVariant?.attributes || quotItem?.attributes || [],
            unitPrice, gstPercentage, quantity: 0,
            priceBeforeGST: 0, gstAmount: 0, priceIncludingGST: 0,
          });
        }
        bucketMap.get(bucketKey).quantity += qty;
      }
    }

    const rows = Array.from(bucketMap.values()).map((r) => {
      const { priceBeforeGST, gstAmount, priceIncludingGST } = calculateItemTotals(r.quantity, r.unitPrice, r.gstPercentage);
      return { ...r, priceBeforeGST, gstAmount, priceIncludingGST };
    });

    const genderOrder = { Male: 1, Female: 2, Unisex: 3, Kids: 4 };
    rows.sort((a, b) => {
      const nameCmp = (a.itemName || "").localeCompare(b.itemName || "");
      if (nameCmp !== 0) return nameCmp;
      const ga = genderOrder[a.gender] || 99;
      const gb = genderOrder[b.gender] || 99;
      if (ga !== gb) return ga - gb;
      const aSig = (a.attributes || []).map((x) => `${x.name}=${x.value}`).join("|");
      const bSig = (b.attributes || []).map((x) => `${x.name}=${x.value}`).join("|");
      return aSig.localeCompare(bSig);
    });

    const subtotalBeforeGST = rows.reduce((s, r) => s + r.priceBeforeGST, 0);
    const totalGST = rows.reduce((s, r) => s + r.gstAmount, 0);
    const customCharges = quotation.customAdditionalCharges || [];
    const customTotal = customCharges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const shipping = Number(quotation.shippingCharges) || 0;
    const grandTotal = subtotalBeforeGST + totalGST + shipping + customTotal;

    const brokenDownQuotation = {
      ...quotation, items: rows,
      subtotalBeforeGST: parseFloat(subtotalBeforeGST.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      paymentSchedule: (quotation.paymentSchedule || []).map((p) => ({
        ...p, amount: parseFloat(((grandTotal * (Number(p.percentage) || 0)) / 100).toFixed(2)),
      })),
    };

    res.json({
      success: true, quotation: brokenDownQuotation, request,
      meta: { breakdownApplied: true, rowCount: rows.length, source: "measurement_mpc_aliases" },
    });
  } catch (error) {
    console.error("Error generating PO breakdown:", error);
    res.status(500).json({ success: false, message: "Server error while generating PO breakdown" });
  }
});

module.exports = router;
// Exposed so other routers can reuse the exact same WO-creation logic instead
// of re-deriving its variant-resolution/BOM-snapshot rules (19 Aug 2026 — R&D's
// "Send to Production" wizard in sampleStyleProduction.js is the first caller).
// Purely additive: router is a function, and a function can carry properties.
module.exports.createWorkOrdersAndProgress = createWorkOrdersAndProgress;