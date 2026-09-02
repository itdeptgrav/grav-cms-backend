// routes/CMS_Routes/Inventory/Operations/deliveries.js
//
// Delivery reads — Store & Purchase Chunk 1C.
//
//   GET /                    → every recorded delivery, newest first
//   GET /data/pending-pos    → orders still owed goods
//   GET /stats/summary       → delivery counts over a period
//   GET /:id                 → one delivery
//
// ── WHAT A DELIVERY ACTUALLY RECORDS, AND WHAT IT DOES NOT ──────────────────
// The stored delivery (PurchaseOrder.deliveries[]) holds a date, an invoice
// number, who received it, and ONE aggregate `quantityReceived`. It does not
// record which line items arrived, how many of each, or at what price.
//
// This file used to invent those facts anyway. It distributed the aggregate
// across the order's lines in proportion to what was ordered, and priced the
// delivery at the average unit price of the order — then returned both as if
// they had been recorded. A store person reconciling an invoice, or an
// accountant valuing stock in transit, had no way to tell the difference
// between a figure somebody wrote down and a figure this file made up.
//
// Estimates are no longer served as facts. Where the data does not exist, the
// API says so — `null`, alongside `itemAllocationRecorded: false` and
// `deliveryValueRecorded: false`, so a client can render "Not recorded"
// instead of a confident wrong number or a misleading ₹0. Recording the real
// per-line receipt is a Goods Receipt, which is Chunk 7's job, not a
// calculation this route can do.

const express = require("express");
const router = express.Router();
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const {
  requireTenant, requireCapability,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { sendError } = require("../../../../services/storePurchase/errors");

router.use(EmployeeAuthMiddleware);
/* Deliveries are company data. Resolved before any query, so no route below
   can be reached without a company to scope it to. */
router.use(requireTenant);

/**
 * What this API can and cannot tell you about one delivery.
 *
 * Returned on every delivery payload rather than documented somewhere else: a
 * client that has to consult a wiki to know whether a number is real will
 * eventually render it as though it were.
 */
/**
 * The quantity this delivery actually recorded.
 *
 * `quantityReceived` is optional in the schema, so plenty of older deliveries
 * carry none. `|| 0` turned every one of those into "0 units received", which
 * is a claim nobody made and the opposite of the truth: something arrived, and
 * how much was never written down. A genuine recorded zero — a delivery that
 * turned up empty — is a real fact and stays 0.
 */
function recordedQuantity(delivery) {
  const q = delivery?.quantityReceived;
  return typeof q === "number" && Number.isFinite(q) ? q : null;
}

/**
 * Does this embedded delivery match what the caller asked for?
 *
 * The Mongo filter selects ORDERS: an order matches if ANY of its deliveries
 * does. Flattening without re-checking each one returned every sibling
 * delivery on a matching order, so a search for one invoice number came back
 * with the whole order's delivery history, and a date range came back with
 * deliveries outside it.
 */
function deliveryMatches(delivery, { startDate, endDate, search, orderMatchedSearch }) {
  if (startDate && new Date(delivery.deliveryDate) < new Date(startDate)) return false;
  if (endDate && new Date(delivery.deliveryDate) > new Date(endDate)) return false;

  /* With no search, every delivery on a selected order is in scope. With one,
     the order may have been selected because ITS OWN fields matched — a PO
     number or a vendor name — in which case all its deliveries are genuinely
     what was asked for. Only when the order was selected purely because one
     delivery's invoice matched must the siblings be dropped. */
  if (!search || orderMatchedSearch) return true;
  return new RegExp(escapeRegex(search), "i").test(delivery.invoiceNumber || "");
}

/** A user's search text is data, not a pattern. */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DELIVERY_LIMITATIONS = Object.freeze({
  /* No per-line receipt exists. The aggregate below is the only quantity that
     was actually recorded. */
  itemAllocationRecorded: false,
  /* Nothing prices a delivery: the order's line prices describe the ORDER, and
     which lines arrived in which delivery is exactly what is not recorded. */
  deliveryValueRecorded: false,
  note: "This delivery recorded a total quantity only. Which items arrived, "
      + "in what quantities, and at what value were not recorded.",
});

/**
 * A tenant-scoped filter that user input cannot escape.
 *
 * The search clause used to be assigned straight onto `filter.$or`. In legacy
 * mode the tenant filter IS an `$or` (companyId missing or null), so a search
 * would have overwritten the company scope entirely. Everything caller-supplied
 * goes inside `$and` instead, where it can only ever narrow.
 */
function scopedFilter(req, extra = {}) {
  const base = { ...tenantContext.tenantFilter(req.tenant) };
  const clauses = [];
  if (extra.$or) {
    clauses.push({ $or: extra.$or });
    delete extra.$or;
  }
  Object.assign(base, extra);
  if (clauses.length) base.$and = [...(base.$and || []), ...clauses];
  return base;
}


// ═══════════════════════════════════════════════════════════════════════════
// GET / — every recorded delivery
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { search = "", rawItem, vendor, status, startDate, endDate } = req.query;

    const extra = {};
    if (search) {
      extra.$or = [
        { poNumber: { $regex: search, $options: "i" } },
        { vendorName: { $regex: search, $options: "i" } },
        { "deliveries.invoiceNumber": { $regex: search, $options: "i" } },
      ];
    }
    if (vendor) extra.vendor = vendor;
    if (status) extra.status = status;
    if (rawItem) extra["items.rawItem"] = rawItem;

    if (startDate || endDate) {
      extra["deliveries.deliveryDate"] = {};
      if (startDate) extra["deliveries.deliveryDate"].$gte = new Date(startDate);
      if (endDate) extra["deliveries.deliveryDate"].$lte = new Date(endDate);
    }

    // Only orders that have actually taken a delivery.
    extra.deliveries = { $exists: true, $not: { $size: 0 } };

    const purchaseOrders = await PurchaseOrder.find(scopedFilter(req, extra))
      .populate("vendor", "companyName")
      .populate("items.rawItem", "name sku unit")
      .populate("deliveries.receivedBy", "name email")
      .sort({ "deliveries.createdAt": -1 });

    const allDeliveries = [];
    let totalQuantity = 0;

    let missingQuantity = 0;
    const searchRe = search ? new RegExp(escapeRegex(search), "i") : null;

    purchaseOrders.forEach((po) => {
      /* Did the ORDER match the search on its own fields, or only through one
         of its deliveries? The answer decides whether its siblings belong. */
      const orderMatchedSearch = Boolean(
        searchRe && (searchRe.test(po.poNumber || "") || searchRe.test(po.vendorName || "")),
      );

      po.deliveries.forEach((delivery) => {
        if (!deliveryMatches(delivery, { startDate, endDate, search, orderMatchedSearch })) return;

        const quantityReceived = recordedQuantity(delivery);
        if (quantityReceived === null) missingQuantity++;
        allDeliveries.push({
          _id: delivery._id,
          poNumber: po.poNumber,
          purchaseOrderId: po._id,
          vendorName: po.vendorName || po.vendor?.companyName,
          vendorId: po.vendor,
          deliveryDate: delivery.deliveryDate,
          invoiceNumber: delivery.invoiceNumber,
          notes: delivery.notes,
          receivedBy: delivery.receivedBy,
          createdAt: delivery.createdAt,
          updatedAt: delivery.updatedAt,

          /* The one quantity that was really recorded — or null when it was
             not, which is a different thing from zero. */
          totalQuantity: quantityReceived,
          deliveryQuantityRecorded: quantityReceived !== null,

          /* Null, not [] and not 0 — an empty list reads as "nothing arrived",
             which is a different and equally wrong claim. */
          items: null,
          totalValue: null,
          ...DELIVERY_LIMITATIONS,

          purchaseOrder: {
            _id: po._id,
            status: po.status,
            totalReceived: po.totalReceived,
            items: po.items,
            totalOrdered: po.items.reduce((sum, item) => sum + (item.quantity || 0), 0),
          },
        });
        totalQuantity += quantityReceived || 0;
      });
    });

    allDeliveries.sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate));

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const recentDeliveries = allDeliveries.filter(
      (d) => new Date(d.deliveryDate) >= weekAgo,
    ).length;

    /* Scoped like everything else — an unscoped count told every company how
       many orders every other company still had outstanding. */
    const pendingPOs = await PurchaseOrder.countDocuments(
      scopedFilter(req, { status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } }),
    );

    res.json({
      success: true,
      deliveries: allDeliveries,
      stats: {
        totalDeliveries: allDeliveries.length,
        /* A total that silently skipped the deliveries with no recorded
           quantity would read as complete and be short. Either the figure
           covers everything or it is not offered. */
        totalQuantity: missingQuantity === 0 ? totalQuantity : null,
        quantityRecordedFor: allDeliveries.length - missingQuantity,
        quantityMissingFor: missingQuantity,
        deliveryQuantityRecorded: missingQuantity === 0,
        /* Summing values nobody recorded produced a total that looked
           authoritative and was arithmetic on guesses. */
        totalValue: null,
        deliveryValueRecorded: false,
        recentDeliveries,
        pendingPOs,
      },
    });
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error fetching deliveries:", error);
    res.status(500).json({ success: false, message: "Server error while fetching deliveries" });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// GET /data/pending-pos — orders still owed goods
//
// Registered BEFORE "/:id". Express matches in order, so with "/:id" first
// this route was unreachable: "data" was read as a delivery id and the request
// died casting it to an ObjectId.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/data/pending-pos", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const purchaseOrders = await PurchaseOrder.find(scopedFilter(req, {
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] },
      totalPending: { $gt: 0 },
    }))
      .select("poNumber vendor vendorName items status totalReceived totalPending expectedDeliveryDate")
      .populate("vendor", "companyName")
      .populate("items.rawItem", "name sku unit")
      .sort({ expectedDeliveryDate: 1 });

    const pendingPOs = purchaseOrders.map((po) => ({
      id: po._id,
      poNumber: po.poNumber,
      vendorName: po.vendorName || po.vendor?.companyName,
      items: po.items.map((item) => ({
        id: item._id,
        name: item.itemName,
        sku: item.sku,
        unit: item.unit,
        ordered: item.quantity,
        received: item.receivedQuantity,
        pending: item.pendingQuantity,
        rawItemId: item.rawItem,
      })),
      totalOrdered: po.items.reduce((sum, item) => sum + (item.quantity || 0), 0),
      totalReceived: po.totalReceived,
      totalPending: po.totalPending,
      expectedDeliveryDate: po.expectedDeliveryDate,
      status: po.status,
    }));

    res.json({ success: true, purchaseOrders: pendingPOs });
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error fetching pending purchase orders:", error);
    res.status(500).json({
      success: false, message: "Server error while fetching pending purchase orders",
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// GET /stats/summary — how many deliveries, and when
// ═══════════════════════════════════════════════════════════════════════════
router.get("/stats/summary", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { period = "month" } = req.query;

    const startDate = new Date();
    switch (period) {
      case "week":    startDate.setDate(startDate.getDate() - 7); break;
      case "quarter": startDate.setMonth(startDate.getMonth() - 3); break;
      case "year":    startDate.setFullYear(startDate.getFullYear() - 1); break;
      case "month":
      default:        startDate.setMonth(startDate.getMonth() - 1); break;
    }

    const purchaseOrders = await PurchaseOrder.find(scopedFilter(req, {
      "deliveries.deliveryDate": { $gte: startDate },
    })).select("deliveries vendor vendorName");

    let totalDeliveries = 0;
    let totalQuantity = 0;
    let missingQuantity = 0;
    const deliveriesByDay = {};
    const byVendor = new Map();

    purchaseOrders.forEach((po) => {
      po.deliveries.forEach((delivery) => {
        if (new Date(delivery.deliveryDate) < startDate) return;
        totalDeliveries++;

        const day = new Date(delivery.deliveryDate).toISOString().split("T")[0];
        deliveriesByDay[day] = (deliveriesByDay[day] || 0) + 1;

        /* The delivery's own recorded quantity. The previous version added up
           every LINE's lifetime received quantity for each delivery, so an
           order with three deliveries counted its whole receipt three times.
           A delivery with no recorded quantity is counted as missing rather
           than as zero. */
        const qty = recordedQuantity(delivery);
        if (qty === null) missingQuantity++;
        else totalQuantity += qty;

        const key = String(po.vendor || po.vendorName || "unknown");
        const row = byVendor.get(key) || {
          _id: po.vendor || null,
          vendorName: po.vendorName || "",
          deliveryCount: 0,
          totalQuantity: 0,
          quantityMissingFor: 0,
          /* Ranking vendors by a value nobody recorded ranked them by an
             arithmetic artefact. */
          totalValue: null,
        };
        row.deliveryCount++;
        if (qty === null) row.quantityMissingFor++;
        else row.totalQuantity += qty;
        byVendor.set(key, row);
      });
    });

    const vendorPerformance = [...byVendor.values()]
      .map((v) => ({
        ...v,
        /* A vendor total that quietly omitted the deliveries with no recorded
           quantity would rank them by an incomplete figure. */
        totalQuantity: v.quantityMissingFor === 0 ? v.totalQuantity : null,
        deliveryQuantityRecorded: v.quantityMissingFor === 0,
      }))
      .sort((a, b) => (b.totalQuantity ?? -1) - (a.totalQuantity ?? -1))
      .slice(0, 5);

    res.json({
      success: true,
      stats: {
        totalDeliveries,
        totalQuantity: missingQuantity === 0 ? totalQuantity : null,
        quantityRecordedFor: totalDeliveries - missingQuantity,
        quantityMissingFor: missingQuantity,
        deliveryQuantityRecorded: missingQuantity === 0,
        totalValue: null,
        deliveryValueRecorded: false,
        deliveriesByDay,
        vendorPerformance,
      },
    });
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error fetching delivery statistics:", error);
    res.status(500).json({
      success: false, message: "Server error while fetching delivery statistics",
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// GET /:id — one delivery
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    /* Scoped in the query, never fetched globally and checked afterwards: a
       delivery belonging to another company must be indistinguishable from one
       that does not exist. */
    const purchaseOrder = await PurchaseOrder.findOne({
      "deliveries._id": req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    })
      .populate("vendor", "companyName contactPerson phone email address gstNumber")
      .populate("items.rawItem", "name sku unit description")
      .populate("deliveries.receivedBy", "name email")
      .populate("createdBy", "name email");

    if (!purchaseOrder) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    const delivery = purchaseOrder.deliveries.find(
      (d) => d._id.toString() === req.params.id,
    );
    if (!delivery) {
      return res.status(404).json({ success: false, message: "Delivery not found" });
    }

    /* ── THE ORDER'S LINES, NOT THIS DELIVERY'S ──────────────────────────────
     * These describe the ORDER: what was asked for, what has arrived in total
     * across every delivery, what is still owed. They are useful, and they are
     * not a breakdown of this delivery. The old `receivedInThisDelivery` field
     * divided each line's lifetime receipt by the number of deliveries and
     * presented the result as fact; it is gone rather than renamed, because a
     * number that cannot be right is not improved by a better label. */
    const orderLines = purchaseOrder.items.map((item) => ({
      itemName: item.itemName,
      sku: item.sku,
      unit: item.unit,
      quantity: item.quantity,
      totalReceived: item.receivedQuantity,
      pendingQuantity: item.pendingQuantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      rawItem: item.rawItem,
      status: item.status,
      vendorNickname: item.vendorNickname || "",
      variantCombination: item.variantCombination || [],
    }));

    res.json({
      success: true,
      delivery: {
        _id: delivery._id,
        poNumber: purchaseOrder.poNumber,
        purchaseOrderId: purchaseOrder._id,
        vendor: purchaseOrder.vendor,
        vendorName: purchaseOrder.vendorName || purchaseOrder.vendor?.companyName,
        deliveryDate: delivery.deliveryDate,
        invoiceNumber: delivery.invoiceNumber,
        notes: delivery.notes,
        receivedBy: delivery.receivedBy,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,

        totalQuantity: recordedQuantity(delivery),
        deliveryQuantityRecorded: recordedQuantity(delivery) !== null,
        items: null,
        totalValue: null,
        ...DELIVERY_LIMITATIONS,

        /* Named for what it is, so nobody reads it as this delivery's contents. */
        purchaseOrderLines: orderLines,

        purchaseOrder: {
          _id: purchaseOrder._id,
          poNumber: purchaseOrder.poNumber,
          orderDate: purchaseOrder.orderDate,
          expectedDeliveryDate: purchaseOrder.expectedDeliveryDate,
          status: purchaseOrder.status,
          totalAmount: purchaseOrder.totalAmount,
          totalReceived: purchaseOrder.totalReceived,
          totalPending: purchaseOrder.totalPending,
          hasPendingQuantities: purchaseOrder.totalPending > 0,
        },
      },
    });
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error fetching delivery:", error);
    res.status(500).json({ success: false, message: "Server error while fetching delivery" });
  }
});

module.exports = router;
