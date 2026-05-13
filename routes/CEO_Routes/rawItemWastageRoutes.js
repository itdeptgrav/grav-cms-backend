// routes/CEO_Routes/rawItemWastageRoutes.js
//
// Tracks raw-item usage vs StockItem-defined BOM with per-WO attribution +
// cost analytics.
//
// COMPLETION SOURCE:
//   WO's own tracked completion field via getWOCompleted(wo), which falls back
//   through: packagingProgress → finishingProgress → stitchingProgress →
//   completedQuantity → completed → cuttingProgress → status-based.
//   This reflects "actual production completion" not just "pieces cut".
//
// Mount:
//   app.use("/api/ceo/raw-item-wastage", require("./routes/CEO_Routes/rawItemWastageRoutes"));

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Barcode         = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const WorkOrder       = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem         = require("../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem       = require("../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Unit            = require("../../models/CMS_Models/Inventory/Configurations/Unit");

router.use(EmployeeAuthMiddleware);

// Common select() spec including all candidate completion fields
const WO_SELECT = "workOrderNumber stockItemId stockItemName stockItemReference variantId variantAttributes quantity customerName customerRequestId status priority productionCompletion";


// ─── WO Completion Reader ────────────────────────────────────────────────
//
// Uses the EXACT same field that the Manufacturing Orders dashboard uses:
//   wo.productionCompletion.overallCompletedQuantity
//
// This is the system's authoritative "completed quantity" for a WO,
// synced from operation completion. Don't change this — it matches the
// MO listing page's progress calculation.
function getWOCompleted(wo) {
  if (!wo) return 0;
  if (typeof wo.productionCompletion?.overallCompletedQuantity === "number") {
    return wo.productionCompletion.overallCompletedQuantity;
  }
  if (wo.status === "completed") return wo.quantity || 0;
  return 0;
}

// Optional: use the WO's pre-computed completion % if present (more accurate
// than recomputing from completed/quantity when partial units are tracked).
function getWOCompletionPct(wo) {
  if (!wo) return 0;
  if (typeof wo.productionCompletion?.overallCompletionPercentage === "number") {
    return Math.min(100, wo.productionCompletion.overallCompletionPercentage);
  }
  const completed = getWOCompleted(wo);
  const total = wo.quantity || 0;
  return total > 0 ? Math.min(100, (completed / total) * 100) : 0;
}


// ─── Unit conversion ───────────────────────────────────────────────────────
async function convertQuantity(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (!quantity || isNaN(quantity)) return quantity;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit })
      .populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const direct = (fromDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === toUnit
      );
      if (direct?.quantity) return quantity * direct.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit })
      .populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const reverse = (toDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === fromUnit
      );
      if (reverse?.quantity) return quantity / reverse.quantity;
    }
    return quantity;
  } catch (err) {
    console.error("[convertQuantity]", err.message);
    return quantity;
  }
}


const parsePieceBarcode = (str) => {
  if (!str || typeof str !== "string") return null;
  const parts = str.trim().split("-");
  if (parts.length < 3 || parts[0] !== "WO") return null;
  const woShortId = parts[1];
  const unitNum   = parseInt(parts[2], 10);
  if (!woShortId || isNaN(unitNum)) return null;
  return { woShortId, unitNum };
};


const dayBounds = (dateStr) => {
  const d = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { start, end };
};


const variantsMatch = (a, b) => {
  if (a.variantId && b.variantId &&
      a.variantId.toString() === b.variantId.toString()) return true;
  const aComb = a.variantCombination || [];
  const bComb = b.variantCombination || [];
  if (aComb.length > 0 && bComb.length > 0) {
    if (aComb.length === bComb.length && aComb.every((v, i) => v === bComb[i])) return true;
  }
  if (!a.variantId && !aComb.length && !b.variantId && !bComb.length) return true;
  return false;
};


function resolveWOBOM(wo, stockItemById) {
  if (!wo.stockItemId) {
    return { bomLines: [], stockItemName: null, genderCategory: "", productImage: null };
  }
  const stockItem = stockItemById.get(wo.stockItemId.toString());
  if (!stockItem) {
    return { bomLines: [], stockItemName: null, genderCategory: "", productImage: null };
  }

  let matched = null;
  if (wo.variantId && stockItem.variants?.length) {
    matched = stockItem.variants.find(v => v._id?.toString() === wo.variantId.toString());
  }
  if (!matched && wo.variantAttributes?.length > 0 && stockItem.variants?.length) {
    matched = stockItem.variants.find(v => {
      if (!v.attributes?.length) return false;
      return wo.variantAttributes.every(va =>
        v.attributes.some(sa => sa.name === va.name && sa.value === va.value)
      );
    });
  }
  if (!matched && stockItem.variants?.length === 1) {
    matched = stockItem.variants[0];
  }

  const variantImage    = matched?.images?.[0] || null;
  const stockItemImage  = stockItem.images?.[0] || null;
  const productImage    = variantImage || stockItemImage || null;

  return {
    stockItemName:      stockItem.name,
    stockItemReference: stockItem.reference,
    genderCategory:     stockItem.genderCategory || "",
    productImage,
    matchedVariantSku:  matched?.sku || null,
    matchedVariantId:   matched?._id || null,
    bomLines:           matched?.rawItems || [],
  };
}


async function buildRawItemMetaCache(rawItemIds) {
  const ids = [...new Set(rawItemIds.filter(Boolean).map(x => x.toString()))];
  if (ids.length === 0) return new Map();
  const rawItems = await RawItem.find({ _id: { $in: ids } })
    .select("name sku unit customUnit").lean();
  return new Map(rawItems.map(r => [r._id.toString(), {
    name: r.name,
    sku:  r.sku,
    registeredUnit: r.customUnit || r.unit || "",
  }]));
}


// ═══════════════════════════════════════════════════════════════════════════
// GET /day-wise?date=YYYY-MM-DD
// ═══════════════════════════════════════════════════════════════════════════
router.get("/day-wise", async (req, res) => {
  try {
    const { date } = req.query;
    const { start, end } = dayBounds(date);

    const barcodes = await Barcode.find({
      "cuttingSessions.closedAt": { $gte: start, $lte: end }
    }).lean();

    if (barcodes.length === 0) {
      return res.json({
        success: true, date: start,
        summary: { uniqueRawItems: 0, uniqueWorkOrders: 0, totalSessions: 0, totalPiecesCut: 0, totalWasteLines: 0, totalSavedLines: 0 },
        costSummary: emptyCostSummary(),
        byRawItem: [], byWorkOrder: [],
      });
    }

    const cells = new Map();
    const rawItemTotals = new Map();
    const woShortIds = new Set();

    for (const b of barcodes) {
      const todaySessions = (b.cuttingSessions || []).filter(s =>
        s.closedAt && s.closedAt >= start && s.closedAt <= end
      );
      if (todaySessions.length === 0) continue;

      const variantKey = b.variantId?.toString() ||
        (b.variantCombination || []).join("|") || "default";
      const rawItemKey = `${b.rawItem?.toString() || "unknown"}::${variantKey}`;

      let rt = rawItemTotals.get(rawItemKey);
      if (!rt) {
        rt = {
          rawItemKey,
          rawItemId:          b.rawItem,
          rawItemName:        b.rawItemName,
          rawItemSku:         b.rawItemSku,
          variantId:          b.variantId,
          variantCombination: b.variantCombination || [],
          variantSku:         b.variantSku || "",
          barcodeUnit:        b.unit,
          sessionCount:       0,
          piecesCount:        0,
          totalUsedInBarcodeUnit: 0,
          barcodeIds:         new Set(),
        };
        rawItemTotals.set(rawItemKey, rt);
      }
      rt.barcodeIds.add(b._id.toString());

      for (const s of todaySessions) {
        rt.sessionCount += 1;
        const used = (s.startQty || 0) - (s.endQty || 0);
        if (used > 0) rt.totalUsedInBarcodeUnit += used;
        rt.piecesCount += (s.scannedPieces || []).length;

        const totalPieces = (s.scannedPieces || []).length;
        if (totalPieces === 0) continue;

        const piecesByWO = new Map();
        const unitsByWO  = new Map();
        for (const piece of (s.scannedPieces || [])) {
          const p = parsePieceBarcode(piece);
          if (!p) continue;
          woShortIds.add(p.woShortId);
          piecesByWO.set(p.woShortId, (piecesByWO.get(p.woShortId) || 0) + 1);
          let set = unitsByWO.get(p.woShortId);
          if (!set) { set = new Set(); unitsByWO.set(p.woShortId, set); }
          set.add(p.unitNum);
        }

        for (const [woShortId, count] of piecesByWO) {
          const cellKey = `${rawItemKey}::${woShortId}`;
          let cell = cells.get(cellKey);
          if (!cell) {
            cell = {
              rawItemKey, woShortId,
              rawItemId:          b.rawItem,
              rawItemName:        b.rawItemName,
              rawItemSku:         b.rawItemSku,
              variantId:          b.variantId,
              variantCombination: b.variantCombination || [],
              barcodeUnit:        b.unit,
              unitNums:           new Set(),
              usedInBarcodeUnit:  0,
              piecesCount:        0,
            };
            cells.set(cellKey, cell);
          }
          for (const u of unitsByWO.get(woShortId)) cell.unitNums.add(u);
          cell.piecesCount += count;
          if (used > 0 && totalPieces > 0) {
            cell.usedInBarcodeUnit += (used * count) / totalPieces;
          }
        }
      }
    }

    // Fetch WOs touched today (with completion-source fields included)
    const allWOs = await WorkOrder.find({}).select(WO_SELECT).lean();
    const woByShortId = new Map();
    for (const wo of allWOs) {
      const sid = wo._id.toString().slice(-8);
      if (woShortIds.has(sid)) woByShortId.set(sid, wo);
    }

    const stockItemIds = [...new Set([...woByShortId.values()]
      .map(w => w.stockItemId?.toString()).filter(Boolean))];
    const stockItems = stockItemIds.length > 0
      ? await StockItem.find({ _id: { $in: stockItemIds } })
          .select("name reference variants genderCategory images").lean()
      : [];
    const stockItemById = new Map(stockItems.map(si => [si._id.toString(), si]));

    const customerRequestIds = [...new Set([...woByShortId.values()]
      .map(w => w.customerRequestId?.toString()).filter(Boolean))];
    const customerRequests = customerRequestIds.length > 0
      ? await CustomerRequest.find({ _id: { $in: customerRequestIds } })
          .select("requestId customerInfo").lean()
      : [];
    const customerRequestById = new Map(customerRequests.map(c => [c._id.toString(), c]));

    const woBOMCache = new Map();
    for (const wo of woByShortId.values()) {
      woBOMCache.set(wo._id.toString(), resolveWOBOM(wo, stockItemById));
    }

    const allRawItemIds = [...rawItemTotals.values()].map(g => g.rawItemId);
    const rawItemMeta = await buildRawItemMetaCache(allRawItemIds);

    // Enrich cells with BOM + cost
    const enrichedCells = [];
    for (const cell of cells.values()) {
      const meta = cell.rawItemId ? rawItemMeta.get(cell.rawItemId.toString()) : null;
      const registeredUnit = meta?.registeredUnit || cell.barcodeUnit;
      if (meta) {
        cell.rawItemName = cell.rawItemName || meta.name;
        cell.rawItemSku  = cell.rawItemSku  || meta.sku;
      }
      const actualUsedInRegistered = await convertQuantity(
        cell.usedInBarcodeUnit, cell.barcodeUnit, registeredUnit
      );

      const wo = woByShortId.get(cell.woShortId);
      const unitsCut = cell.unitNums.size;

      let bomLine = null;
      let perUnitInRegistered = 0;
      let perUnitInBomUnit = 0;
      let bomLineUnit = registeredUnit;
      let unitCost = 0;
      let note = null;

      if (!wo) {
        note = "WO not found";
      } else {
        const woBom = woBOMCache.get(wo._id.toString());
        if (!woBom || woBom.bomLines.length === 0) {
          note = woBom?.stockItemName ? "No variant BOM found on product" : "Stock item not found for this WO";
        } else {
          bomLine = woBom.bomLines.find(line => {
            const sameRaw = line.rawItemId?.toString() === cell.rawItemId?.toString();
            if (!sameRaw) return false;
            return variantsMatch(
              { variantId: line.variantId, variantCombination: line.variantCombination },
              { variantId: cell.variantId, variantCombination: cell.variantCombination }
            );
          });
          if (!bomLine) note = "Raw-item not in product's BOM";
          else {
            perUnitInBomUnit    = bomLine.quantity || 0;
            bomLineUnit         = bomLine.unit;
            unitCost            = bomLine.unitCost || 0;
            perUnitInRegistered = await convertQuantity(perUnitInBomUnit, bomLineUnit, registeredUnit);
          }
        }
      }

      const expectedForUnitsCut = perUnitInRegistered * unitsCut;
      const actualUsedInBomUnit = bomLine
        ? await convertQuantity(cell.usedInBarcodeUnit, cell.barcodeUnit, bomLineUnit) : 0;
      const expectedCost = bomLine ? (perUnitInBomUnit * unitCost * unitsCut) : 0;
      const actualCost   = bomLine ? (actualUsedInBomUnit * unitCost) : 0;
      const wasteCost    = actualCost - expectedCost;

      enrichedCells.push({
        ...cell, registeredUnit, actualUsedInRegistered, actualUsedInBomUnit,
        unitsCut, bomLine, bomLineUnit, unitCost, perUnitInBomUnit,
        perUnitInRegistered, expectedForUnitsCut, expectedCost, actualCost, wasteCost, note,
      });
    }

    // byRawItem
    const byRawItem = [];
    for (const rt of rawItemTotals.values()) {
      const meta = rt.rawItemId ? rawItemMeta.get(rt.rawItemId.toString()) : null;
      const registeredUnit = meta?.registeredUnit || rt.barcodeUnit;
      if (meta) { rt.rawItemName = rt.rawItemName || meta.name; rt.rawItemSku = rt.rawItemSku || meta.sku; }
      const totalUsedInRegisteredUnit = await convertQuantity(
        rt.totalUsedInBarcodeUnit, rt.barcodeUnit, registeredUnit
      );

      const myCells = enrichedCells.filter(c => c.rawItemKey === rt.rawItemKey);
      let bomExpectedQty = 0, expectedCost = 0, actualCost = 0;
      const woBreakdown = [];

      for (const c of myCells) {
        bomExpectedQty += c.expectedForUnitsCut;
        expectedCost   += c.expectedCost;
        actualCost     += c.actualCost;

        const wo = woByShortId.get(c.woShortId);
        const cr = wo?.customerRequestId
          ? customerRequestById.get(wo.customerRequestId.toString()) : null;

        woBreakdown.push({
          woShortId:          c.woShortId,
          workOrderNumber:    wo?.workOrderNumber || null,
          stockItemName:      wo?.stockItemName || null,
          customerName:       wo?.customerName || cr?.customerInfo?.name || null,
          customerRequestId:  wo?.customerRequestId || null,
          requestId:          cr?.requestId || null,
          unitsCut:           c.unitsCut,
          unitsInWO:          wo?.quantity || 0,
          perUnitExpected:    c.perUnitInRegistered,
          expectedForUnitsCut:c.expectedForUnitsCut,
          actualUsedAttributed: c.actualUsedInRegistered,
          expectedUnit:       registeredUnit,
          unitCost:           c.unitCost,
          expectedCost:       c.expectedCost,
          actualCost:         c.actualCost,
          wasteCost:          c.wasteCost,
          note:               c.note,
        });
      }

      const wasteQty = totalUsedInRegisteredUnit - bomExpectedQty;
      const wastePct = bomExpectedQty > 0 ? (wasteQty / bomExpectedQty) * 100 : null;
      const wasteCost = actualCost - expectedCost;

      byRawItem.push({
        rawItemId: rt.rawItemId,
        rawItemName: rt.rawItemName || "Unknown",
        rawItemSku: rt.rawItemSku,
        variantId: rt.variantId,
        variantCombination: rt.variantCombination,
        variantSku: rt.variantSku,
        barcodeUnit: rt.barcodeUnit,
        registeredUnit,
        sessionCount: rt.sessionCount,
        piecesCount: rt.piecesCount,
        barcodesCount: rt.barcodeIds.size,
        totalUsedInBarcodeUnit: rt.totalUsedInBarcodeUnit,
        totalUsedInRegisteredUnit,
        bomExpectedQty,
        bomExpectedUnit: registeredUnit,
        wasteQty, wastePct,
        expectedCost, actualCost, wasteCost,
        workOrders: woBreakdown,
      });
    }
    byRawItem.sort((a, b) => Math.abs(b.wasteQty || 0) - Math.abs(a.wasteQty || 0));

    // byWorkOrder — uses getWOCompleted(wo) for the OVERALL completion bar
    const byWorkOrderMap = new Map();
    for (const c of enrichedCells) {
      if (!byWorkOrderMap.has(c.woShortId)) {
        const wo = woByShortId.get(c.woShortId);
        const woBom = wo ? woBOMCache.get(wo._id.toString()) : null;
        const cr = wo?.customerRequestId
          ? customerRequestById.get(wo.customerRequestId.toString()) : null;

        const completedQty = getWOCompleted(wo);
        const completionPct = getWOCompletionPct(wo);

        byWorkOrderMap.set(c.woShortId, {
          woShortId: c.woShortId,
          woId: wo?._id || null,
          workOrderNumber: wo?.workOrderNumber || null,
          stockItemName: wo?.stockItemName || null,
          stockItemReference: wo?.stockItemReference || null,
          productImage: woBom?.productImage || null,
          genderCategory: woBom?.genderCategory || "",
          customerName: wo?.customerName || cr?.customerInfo?.name || null,
          customerRequestId: wo?.customerRequestId || null,
          requestId: cr?.requestId || null,
          quantity: wo?.quantity || 0,
          status: wo?.status || null,
          priority: wo?.priority || null,
          completedQty, completionPct,
          rawMaterials: [],
          unitsCutTodaySet: new Set(),
          totalExpectedCostToday: 0,
          totalActualCostToday:   0,
          totalWasteCostToday:    0,
        });
      }
      const entry = byWorkOrderMap.get(c.woShortId);
      for (const u of c.unitNums) entry.unitsCutTodaySet.add(u);

      entry.rawMaterials.push({
        rawItemId: c.rawItemId,
        rawItemName: c.rawItemName || "Unknown",
        rawItemSku: c.rawItemSku,
        variantCombination: c.variantCombination,
        registeredUnit: c.registeredUnit,
        barcodeUnit: c.barcodeUnit,
        bomLineUnit: c.bomLineUnit,
        unitsCutFromThisWO: c.unitsCut,
        perUnitExpected: c.perUnitInRegistered,
        expectedForCutUnits: c.expectedForUnitsCut,
        actualUsedInRegistered: c.actualUsedInRegistered,
        wasteQty: c.actualUsedInRegistered - c.expectedForUnitsCut,
        wastePct: c.expectedForUnitsCut > 0
          ? ((c.actualUsedInRegistered - c.expectedForUnitsCut) / c.expectedForUnitsCut) * 100
          : null,
        unitCost: c.unitCost,
        expectedCost: c.expectedCost,
        actualCost: c.actualCost,
        wasteCost: c.wasteCost,
        piecesCount: c.piecesCount,
        note: c.note,
      });

      entry.totalExpectedCostToday += c.expectedCost;
      entry.totalActualCostToday   += c.actualCost;
      entry.totalWasteCostToday    += c.wasteCost;
    }

    const byWorkOrder = [...byWorkOrderMap.values()].map(e => ({
      ...e,
      unitsCutToday: e.unitsCutTodaySet.size,
      unitsCutTodaySet: undefined,
    })).sort((a, b) => Math.abs(b.totalWasteCostToday) - Math.abs(a.totalWasteCostToday));

    const costSummary = {
      totalExpectedCost: byRawItem.reduce((s, r) => s + (r.expectedCost || 0), 0),
      totalActualCost:   byRawItem.reduce((s, r) => s + (r.actualCost   || 0), 0),
    };
    costSummary.totalWasteCost = costSummary.totalActualCost - costSummary.totalExpectedCost;
    costSummary.variancePct = costSummary.totalExpectedCost > 0
      ? (costSummary.totalWasteCost / costSummary.totalExpectedCost) * 100 : null;
    const totalPiecesCutToday = enrichedCells.reduce((s, c) => s + c.unitNums.size, 0);
    costSummary.totalPiecesCut = totalPiecesCutToday;
    costSummary.avgExpectedCostPerPiece = totalPiecesCutToday > 0
      ? costSummary.totalExpectedCost / totalPiecesCutToday : 0;
    costSummary.avgActualCostPerPiece = totalPiecesCutToday > 0
      ? costSummary.totalActualCost / totalPiecesCutToday : 0;
    costSummary.costPerPieceDelta =
      costSummary.avgActualCostPerPiece - costSummary.avgExpectedCostPerPiece;

    const summary = {
      date: start,
      uniqueRawItems:   new Set(byRawItem.map(r => r.rawItemId?.toString())).size,
      uniqueWorkOrders: byWorkOrder.length,
      totalSessions:    byRawItem.reduce((s, r) => s + r.sessionCount, 0),
      totalPiecesCut:   byRawItem.reduce((s, r) => s + r.piecesCount, 0),
      totalWasteLines:  byRawItem.filter(r => r.wasteQty > 0).length,
      totalSavedLines:  byRawItem.filter(r => r.wasteQty < 0).length,
    };

    res.json({ success: true, date: start, summary, costSummary, byRawItem, byWorkOrder });
  } catch (err) {
    console.error("day-wise wastage error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


function emptyCostSummary() {
  return {
    totalExpectedCost: 0, totalActualCost: 0, totalWasteCost: 0,
    variancePct: null, totalPiecesCut: 0,
    avgExpectedCostPerPiece: 0, avgActualCostPerPiece: 0, costPerPieceDelta: 0,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// GET /orders-list?search=
// Completion uses getWOCompleted(wo) — the WO's tracked completion value.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/orders-list", async (req, res) => {
  try {
    const { search = "" } = req.query;

    const matchQuery = {};
    if (search) {
      matchQuery.$or = [
        { requestId:            { $regex: search, $options: "i" } },
        { "customerInfo.name":  { $regex: search, $options: "i" } },
        { "customerInfo.email": { $regex: search, $options: "i" } },
        { "items.stockItemName":{ $regex: search, $options: "i" } },
      ];
    }

    const orders = await CustomerRequest.find(matchQuery)
      .select("requestId customerInfo customerId status priority createdAt items")
      .sort({ createdAt: -1 })
      .limit(300).lean();

    if (orders.length === 0) return res.json({ success: true, orders: [], count: 0 });

    const orderIds = orders.map(o => o._id);

    const ordersWOs = await WorkOrder.find({ customerRequestId: { $in: orderIds } })
      .select(WO_SELECT).lean();

    const perOrder = new Map();
    for (const wo of ordersWOs) {
      const orderId = wo.customerRequestId.toString();
      const completed = getWOCompleted(wo);
      let agg = perOrder.get(orderId);
      if (!agg) { agg = { woCount: 0, totalQty: 0, completedQty: 0 }; perOrder.set(orderId, agg); }
      agg.woCount += 1;
      agg.totalQty += wo.quantity || 0;
      agg.completedQty += completed;
    }

    const cards = orders.map(o => {
      const stats = perOrder.get(o._id.toString());
      if (!stats || stats.woCount === 0) return null;

      const products = (o.items || []).map(i => i.stockItemName).filter(Boolean);
      const uniqueProducts = [...new Set(products)];
      const completionPct = stats.totalQty > 0
        ? (stats.completedQty / stats.totalQty) * 100 : 0;

      return {
        _id:              o._id,
        requestId:        o.requestId,
        customerName:     o.customerInfo?.name || "Unknown",
        customerEmail:    o.customerInfo?.email,
        status:           o.status,
        priority:         o.priority,
        createdAt:        o.createdAt,
        woCount:          stats.woCount,
        totalQty:         stats.totalQty || 0,
        completedQty:     stats.completedQty || 0,
        completionPct,
        productNames:     uniqueProducts,
        productNamesShort:uniqueProducts.slice(0, 3).join(", ") +
                          (uniqueProducts.length > 3 ? ` +${uniqueProducts.length - 3}` : ""),
      };
    }).filter(Boolean);

    res.json({ success: true, orders: cards, count: cards.length });
  } catch (err) {
    console.error("orders-list error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// GET /order-wise/:orderId
// Per-WO completion + order completion use getWOCompleted(wo).
// Per-RM accounting still uses session data (that's the BOM-vs-actual math).
// ═══════════════════════════════════════════════════════════════════════════
router.get("/order-wise/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    const order = await CustomerRequest.findById(orderId)
      .select("requestId customerInfo status priority createdAt items").lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const wos = await WorkOrder.find({ customerRequestId: orderId })
      .select(WO_SELECT).lean();

    if (wos.length === 0) {
      return res.json({
        success: true,
        order: {
          _id: order._id, requestId: order.requestId,
          customerName: order.customerInfo?.name,
          status: order.status, priority: order.priority,
          createdAt: order.createdAt,
          totalUnitsOrdered: 0, totalUnitsCompleted: 0, completionPct: 0,
        },
        workOrders: [], rawMaterials: [], costSummary: emptyOrderCostSummary(),
      });
    }

    const stockItemIds = [...new Set(wos.map(w => w.stockItemId?.toString()).filter(Boolean))];
    const stockItems = stockItemIds.length > 0
      ? await StockItem.find({ _id: { $in: stockItemIds } })
          .select("name reference variants genderCategory images").lean()
      : [];
    const stockItemById = new Map(stockItems.map(si => [si._id.toString(), si]));

    const woByShortId = new Map(wos.map(w => [w._id.toString().slice(-8), w]));

    const woBOMs = new Map();
    for (const wo of wos) woBOMs.set(wo._id.toString(), resolveWOBOM(wo, stockItemById));

    const woShortIds = [...woByShortId.keys()];
    const barcodes = woShortIds.length > 0
      ? await Barcode.find({
          "cuttingSessions.scannedPieces": {
            $regex: new RegExp(`^WO-(${woShortIds.join("|")})-`, "i")
          }
        }).lean()
      : [];

    // Aggregate by (rawItem + variant)
    const aggMap = new Map();
    for (const wo of wos) {
      const bom = woBOMs.get(wo._id.toString());
      const shortId = wo._id.toString().slice(-8);
      const woCompletedQty = getWOCompleted(wo);
      const woCompletionPct = getWOCompletionPct(wo);

      for (const line of (bom?.bomLines || [])) {
        const variantKey = line.variantId?.toString() ||
          (line.variantCombination || []).join("|") || "default";
        const key = `${line.rawItemId.toString()}::${variantKey}`;

        let agg = aggMap.get(key);
        if (!agg) {
          agg = {
            rawItemId: line.rawItemId,
            rawItemName: line.rawItemName,
            rawItemSku: line.rawItemSku,
            variantId: line.variantId,
            variantCombination: line.variantCombination || [],
            bomUnit: line.unit,
            perUnitInBomUnit: line.quantity || 0,
            unitCost: line.unitCost || 0,
            registeredUnit: null,
            perUnitInRegistered: 0,
            totalOrderUnits: 0,
            totalExpectedInRegistered: 0,
            totalUnitsCut: 0,
            expectedForCutUnits: 0,
            totalActualInRegistered: 0,
            totalExpectedCostFullOrder: 0,
            expectedCostForCutUnits: 0,
            actualCostForCutUnits: 0,
            wasteCostForCutUnits: 0,
            workOrders: [],
          };
          aggMap.set(key, agg);
        }

        agg.workOrders.push({
          woId: wo._id,
          woShortId: shortId,
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          stockItemReference: wo.stockItemReference,
          productImage: bom?.productImage || null,
          genderCategory: bom?.genderCategory || "",
          woQty: wo.quantity,
          status: wo.status,
          priority: wo.priority,
          // WO's tracked overall completion (for the progress bar)
          completedQtyOverall:  woCompletedQty,
          completionPctOverall: woCompletionPct,
          // Per-RM session-derived units (for the BOM-vs-actual math, NOT for the bar)
          unitsCut: 0,
          expectedInRegistered: 0,
          expectedForCutUnits: 0,
          actualUsedInRegistered: 0,
          expectedCost: 0, actualCost: 0, wasteCost: 0,
        });
        agg.totalOrderUnits += (wo.quantity || 0);
      }
    }

    const rawItemMeta = await buildRawItemMetaCache([...aggMap.values()].map(a => a.rawItemId));

    // Per-RM session-derived math (unchanged — this is for material consumption,
    // not for the completion progress bar)
    for (const agg of aggMap.values()) {
      const meta = agg.rawItemId ? rawItemMeta.get(agg.rawItemId.toString()) : null;
      agg.registeredUnit = meta?.registeredUnit || agg.bomUnit;
      if (meta) {
        agg.rawItemName = agg.rawItemName || meta.name;
        agg.rawItemSku  = agg.rawItemSku  || meta.sku;
      }

      agg.perUnitInRegistered = await convertQuantity(
        agg.perUnitInBomUnit, agg.bomUnit, agg.registeredUnit
      );
      agg.totalExpectedInRegistered  = agg.perUnitInRegistered * agg.totalOrderUnits;
      agg.totalExpectedCostFullOrder = agg.perUnitInBomUnit * agg.unitCost * agg.totalOrderUnits;

      for (const we of agg.workOrders) {
        we.expectedInRegistered = agg.perUnitInRegistered * (we.woQty || 0);
      }

      const woUnitsThisRM = new Map();
      const woUsageBC     = new Map();
      const woBarcodeUnit = new Map();

      for (const b of barcodes) {
        const sameRaw = b.rawItem?.toString() === agg.rawItemId?.toString();
        if (!sameRaw) continue;
        if (!variantsMatch(
          { variantId: b.variantId, variantCombination: b.variantCombination },
          { variantId: agg.variantId, variantCombination: agg.variantCombination }
        )) continue;

        const barcodeUnit = b.unit;
        for (const s of (b.cuttingSessions || [])) {
          if (!s.closedAt) continue;

          const piecesByWO = new Map();
          for (const p of (s.scannedPieces || [])) {
            const parsed = parsePieceBarcode(p);
            if (!parsed || !woByShortId.has(parsed.woShortId)) continue;
            piecesByWO.set(parsed.woShortId, (piecesByWO.get(parsed.woShortId) || 0) + 1);

            let set = woUnitsThisRM.get(parsed.woShortId);
            if (!set) { set = new Set(); woUnitsThisRM.set(parsed.woShortId, set); }
            set.add(parsed.unitNum);
          }
          if (piecesByWO.size === 0) continue;

          const totalPieces = (s.scannedPieces || []).length || 1;
          const usedInSession = (s.startQty || 0) - (s.endQty || 0);
          if (usedInSession <= 0) continue;

          for (const [shortId, count] of piecesByWO) {
            const attributedInBarcodeUnit = (usedInSession * count) / totalPieces;
            woUsageBC.set(shortId, (woUsageBC.get(shortId) || 0) + attributedInBarcodeUnit);
            woBarcodeUnit.set(shortId, barcodeUnit);
          }
        }
      }

      for (const we of agg.workOrders) {
        const set = woUnitsThisRM.get(we.woShortId);
        we.unitsCut = set ? set.size : 0;
        we.expectedForCutUnits = agg.perUnitInRegistered * we.unitsCut;
        we.expectedCost        = agg.perUnitInBomUnit * agg.unitCost * we.unitsCut;

        const usedBC      = woUsageBC.get(we.woShortId) || 0;
        const usedBCUnit  = woBarcodeUnit.get(we.woShortId) || agg.bomUnit;
        we.actualUsedInRegistered = await convertQuantity(usedBC, usedBCUnit, agg.registeredUnit);
        const actualInBomUnit     = await convertQuantity(usedBC, usedBCUnit, agg.bomUnit);
        we.actualCost = actualInBomUnit * agg.unitCost;
        we.wasteCost  = we.actualCost - we.expectedCost;

        agg.totalUnitsCut           += we.unitsCut;
        agg.expectedForCutUnits     += we.expectedForCutUnits;
        agg.totalActualInRegistered += we.actualUsedInRegistered;
        agg.expectedCostForCutUnits += we.expectedCost;
        agg.actualCostForCutUnits   += we.actualCost;
      }

      agg.wasteCostForCutUnits = agg.actualCostForCutUnits - agg.expectedCostForCutUnits;
      agg.wasteVsFullOrder     = agg.totalActualInRegistered - agg.totalExpectedInRegistered;
      agg.wasteVsCutUnits      = agg.totalActualInRegistered - agg.expectedForCutUnits;
      agg.wasteVsCutUnitsPct   = agg.expectedForCutUnits > 0
        ? ((agg.totalActualInRegistered - agg.expectedForCutUnits) / agg.expectedForCutUnits) * 100
        : null;
    }

    const rawMaterials = [...aggMap.values()]
      .sort((a, b) => Math.abs(b.wasteCostForCutUnits || 0) - Math.abs(a.wasteCostForCutUnits || 0));

    // ─── Order-level totals from WO completion fields ───
    const totalUnitsOrdered   = wos.reduce((s, w) => s + (w.quantity || 0), 0);
    const totalUnitsCompleted = wos.reduce((s, w) => s + getWOCompleted(w), 0);
    const completionPct = totalUnitsOrdered > 0
      ? (totalUnitsCompleted / totalUnitsOrdered) * 100 : 0;

    const totalExpectedCostFullOrder = rawMaterials.reduce((s, r) => s + (r.totalExpectedCostFullOrder || 0), 0);
    const totalActualCostSoFar       = rawMaterials.reduce((s, r) => s + (r.actualCostForCutUnits || 0), 0);
    const totalExpectedCostForCutSoFar = rawMaterials.reduce((s, r) => s + (r.expectedCostForCutUnits || 0), 0);
    const totalWasteCostSoFar = totalActualCostSoFar - totalExpectedCostForCutSoFar;

    const wasteRatio = totalExpectedCostForCutSoFar > 0
      ? totalActualCostSoFar / totalExpectedCostForCutSoFar : 1;
    const projectedTotalActualCost = totalExpectedCostFullOrder * wasteRatio;
    const projectedWasteCost = projectedTotalActualCost - totalExpectedCostFullOrder;

    const expectedCostPerUnit = totalUnitsOrdered > 0
      ? totalExpectedCostFullOrder / totalUnitsOrdered : 0;
    // Per-piece cost: divided by units that have CONSUMED material (cut units),
    // since material cost only accrues after cutting starts
    const totalUnitsConsumedMaterial = rawMaterials.length > 0
      ? Math.max(...rawMaterials.map(r => r.totalUnitsCut || 0)) : 0;
    const actualCostPerProducedUnit = totalUnitsConsumedMaterial > 0
      ? totalActualCostSoFar / totalUnitsConsumedMaterial : 0;
    const overallWastePct = totalExpectedCostForCutSoFar > 0
      ? ((totalActualCostSoFar - totalExpectedCostForCutSoFar) / totalExpectedCostForCutSoFar) * 100
      : null;

    const costSummary = {
      totalExpectedCostFullOrder, totalActualCostSoFar,
      totalExpectedCostForCutSoFar, totalWasteCostSoFar,
      projectedTotalActualCost, projectedWasteCost,
      expectedCostPerUnit, actualCostPerProducedUnit,
      costPerPieceDelta: actualCostPerProducedUnit - expectedCostPerUnit,
      overallWastePct,
      totalUnitsOrdered, totalUnitsCompleted,
      productionCompletionPct: completionPct,
    };

    // WO summary cards: use WO completion field
    const workOrdersOut = wos.map(wo => {
      const bom = woBOMs.get(wo._id.toString());
      const completed = getWOCompleted(wo);
      const pct = getWOCompletionPct(wo);
      return {
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        stockItemName: wo.stockItemName,
        stockItemReference: wo.stockItemReference,
        productImage: bom?.productImage || null,
        genderCategory: bom?.genderCategory || "",
        quantity: wo.quantity,
        status: wo.status,
        priority: wo.priority,
        completedQty: completed,
        unitsRemaining: Math.max(0, (wo.quantity || 0) - completed),
        completionPct: pct,
      };
    });

    res.json({
      success: true,
      order: {
        _id:           order._id,
        requestId:     order.requestId,
        customerName:  order.customerInfo?.name,
        customerEmail: order.customerInfo?.email,
        status:        order.status,
        priority:      order.priority,
        createdAt:     order.createdAt,
        totalUnitsOrdered, totalUnitsCompleted, completionPct,
      },
      workOrders: workOrdersOut,
      rawMaterials,
      costSummary,
    });
  } catch (err) {
    console.error("order-wise wastage error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


function emptyOrderCostSummary() {
  return {
    totalExpectedCostFullOrder: 0, totalActualCostSoFar: 0,
    totalExpectedCostForCutSoFar: 0, totalWasteCostSoFar: 0,
    projectedTotalActualCost: 0, projectedWasteCost: 0,
    expectedCostPerUnit: 0, actualCostPerProducedUnit: 0,
    costPerPieceDelta: 0, overallWastePct: null,
    totalUnitsOrdered: 0, totalUnitsCompleted: 0,
    productionCompletionPct: 0,
  };
}


module.exports = router;