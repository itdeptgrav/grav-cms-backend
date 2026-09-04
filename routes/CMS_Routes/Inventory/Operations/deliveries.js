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
const { fail, sendError } = require("../../../../services/storePurchase/errors");

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
function deliveryMatches(delivery, { from, to, searchRe, orderMatchedSearch }) {
  const when = new Date(delivery.deliveryDate);
  if (from && !(when >= from)) return false;
  if (to && !(when <= to)) return false;

  /* With no search, every delivery on a selected order is in scope. With one,
     the order may have been selected because ITS OWN fields matched — a PO
     number or a vendor name — in which case all its deliveries are genuinely
     what was asked for. Only when the order was selected purely because one
     delivery's invoice matched must the siblings be dropped. */
  if (!searchRe || orderMatchedSearch) return true;
  return searchRe.test(delivery.invoiceNumber || "");
}

/**
 * A user's search text is data, not a pattern.
 *
 * It reached `$regex` unescaped. A name containing `(` was a 500; `.*` matched
 * every order in the company; and `(a+)+$` is the classic catastrophic
 * backtracking string, which turns one search box into a way to pin the
 * database. The in-memory pass escaped it and the query did not, so the two
 * also disagreed about what matched.
 */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* An ISO datetime that STATES its zone: a trailing Z, or ±HH:MM. */
const DATETIME_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date that actually exists, as a UTC instant.
 *
 * `new Date("2026-02-31")` does not throw — it rolls over to March 3rd, and
 * `2026-02-29` in a non-leap year becomes March 1st. Either way the filter then
 * covers a day the caller never asked for, and nothing says so. The parsed
 * date is therefore round-tripped through its UTC calendar components and
 * compared with what was typed: a date that rolled over no longer matches
 * itself, and is refused.
 */
function utcCalendarDate(text, endOfDay) {
  const [y, m, d] = text.split("-").map(Number);
  const parsed = new Date(endOfDay
    ? Date.UTC(y, m - 1, d, 23, 59, 59, 999)
    : Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  if (
    parsed.getUTCFullYear() !== y
    || parsed.getUTCMonth() !== m - 1
    || parsed.getUTCDate() !== d
  ) {
    return null;
  }
  return parsed;
}

/**
 * Parse one end of a date filter.
 *
 * ── THE TIMEZONE RULE, STATED ONCE ──────────────────────────────────────────
 * A date-only bound is a UTC calendar day: `2026-08-31` means
 * `2026-08-31T00:00:00.000Z` at the start of a range and
 * `2026-08-31T23:59:59.999Z` at the end. It is deliberately NOT the server's
 * local day — the same request has to select the same deliveries whether it is
 * served from a laptop in Mumbai or a container running UTC, and
 * `new Date("2026-08-31")` gave a different instant depending on which.
 *
 * A datetime bound must say which zone it is in: a trailing `Z` or an explicit
 * `±HH:MM`. `2026-08-31T17:45` names no instant on its own, and inferring one
 * from the server clock is how a saved report quietly changes meaning when it
 * is deployed somewhere else. It is refused rather than guessed at.
 *
 * ── WHY `endDate` IS NOT WHAT THE CALLER SENT ───────────────────────────────
 * A date-only end covers the whole day, because midnight excluded every
 * delivery that arrived during the 31st — the day the person explicitly asked
 * for. A bound carrying a time is honoured exactly, because somebody who wrote
 * one meant it.
 *
 * Returns `{ ok, value, reason }` rather than a Date, so an unparseable filter
 * is refused with a sentence instead of becoming `Invalid Date` — which Mongo
 * accepts as a comparison that quietly matches nothing.
 */
function parseBoundary(raw, edge) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: true, value: null };
  }
  const text = String(raw).trim();

  if (DATE_ONLY.test(text)) {
    const value = utcCalendarDate(text, edge === "end");
    return value
      ? { ok: true, value }
      : { ok: false, reason: `"${text}" is not a date on the calendar.` };
  }

  const zoned = DATETIME_WITH_ZONE.exec(text);
  if (zoned) {
    /* ── THE CALENDAR IS CHECKED HERE TOO ──────────────────────────────────
     * The regex proves the SHAPE, not that the day exists. `new Date()` is as
     * forgiving with a time attached as it is without one:
     * `2026-02-31T17:45:00Z` becomes March 3rd and
     * `2026-04-31T17:45:00+05:30` becomes May 1st, each filtering by a day
     * nobody asked for. The date-only branch above already refuses those; a
     * datetime has to be held to the same standard.
     *
     * The calendar portion is validated on its own, independently of the
     * offset — an offset shifts which instant a valid local date names, it
     * cannot make the 31st of February exist. Only then is the whole string
     * converted, and the offset does its ordinary work. */
    const [, y, m, d, hh, mm, ss] = zoned;
    if (!utcCalendarDate(`${y}-${m}-${d}`, false)) {
      return { ok: false, reason: `"${text}" is not a date on the calendar.` };
    }
    if (Number(hh) > 23 || Number(mm) > 59 || (ss !== undefined && Number(ss) > 59)) {
      return { ok: false, reason: `"${text}" is not a time on the clock.` };
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime())
      ? { ok: false, reason: `"${text}" is not a date this can filter by.` }
      : { ok: true, value: parsed };
  }

  return {
    ok: false,
    reason: `"${text}" must be a date (YYYY-MM-DD) or a time that states its zone `
          + `(ending Z, or +05:30). Without one it means a different instant on every server.`,
  };
}

/**
 * Both ends of the range, or a refusal naming which end is wrong.
 *
 * A backwards range used to return an empty list, which reads as "no
 * deliveries" rather than "you asked for an impossible window".
 */
function parseDateRange(query) {
  const from = parseBoundary(query.startDate, "start");
  if (!from.ok) {
    return { ok: false, field: "startDate", message: from.reason };
  }
  const to = parseBoundary(query.endDate, "end");
  if (!to.ok) {
    return { ok: false, field: "endDate", message: to.reason };
  }
  if (from.value && to.value && from.value > to.value) {
    return {
      ok: false,
      field: "endDate",
      message: "The end of the date range is before its start.",
    };
  }
  return { ok: true, from: from.value, to: to.value };
}

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
    const { search = "", rawItem, vendor, status } = req.query;

    /* Parsed once. The same two Date objects bound the database query and the
       per-delivery pass below, so the two cannot disagree about which day a
       delivery falls on. */
    const range = parseDateRange(req.query);
    if (!range.ok) {
      return sendError(res, fail("VALIDATION", range.message, { field: range.field }));
    }
    const { from, to } = range;

    const extra = {};
    const searchRe = search ? new RegExp(escapeRegex(search), "i") : null;
    if (searchRe) {
      /* Escaped. See escapeRegex — this string came from a text box. */
      extra.$or = [
        { poNumber: searchRe },
        { vendorName: searchRe },
        { "deliveries.invoiceNumber": searchRe },
      ];
    }
    if (vendor) extra.vendor = vendor;
    if (status) extra.status = status;
    if (rawItem) extra["items.rawItem"] = rawItem;

    if (from || to) {
      extra["deliveries.deliveryDate"] = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      };
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

    purchaseOrders.forEach((po) => {
      /* Did the ORDER match the search on its own fields, or only through one
         of its deliveries? The answer decides whether its siblings belong. */
      const orderMatchedSearch = Boolean(
        searchRe && (searchRe.test(po.poNumber || "") || searchRe.test(po.vendorName || "")),
      );

      po.deliveries.forEach((delivery) => {
        if (!deliveryMatches(delivery, { from, to, searchRe, orderMatchedSearch })) return;

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
