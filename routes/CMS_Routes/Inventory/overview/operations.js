// routes/CMS_Routes/Inventory/overview/operations.js
//
// GET /api/cms/inventory/overview/operations
//
// The Store & Purchase operational home, in ONE company-scoped read. It answers
// "what needs my attention, and where do I click?" with named work queues, each
// carrying a count, a few bounded top rows, hasMore, an authoritative source
// label and a destination href that the target workspace genuinely filters by.
//
// HONESTY CONTRACT (tested):
//   · Every figure is a company-scoped DB count / bounded query — never an
//     in-memory scan of a whole collection.
//   · One optional section failing does NOT become a silent zero: it returns
//     { available:false, unavailableReason } and the rest of the home still
//     loads. (Chosen deliberately over failing the whole overview.)
//   · Counts are counts of documents/lines — no quantity is ever summed, so
//     unlike units are never added together.
//   · A reservation shortage is a purchasing signal, NOT negative stock.
//   · Services are never mixed into physical-stock queues.

"use strict";

const express = require("express");
const router = express.Router();

const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const SupplierOffer = require("../../../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceOrder = require("../../../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const StockCount = require("../../../../models/CMS_Models/Inventory/Operations/StockCount");
const StockReservation = require("../../../../models/CMS_Models/Inventory/Operations/StockReservation");
const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptPutaway = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptPutaway");
const GoodsReceiptDisposition = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
const control = require("../../../../services/storePurchase/goodsReceiptControl.service");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability } = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { CAPABILITIES } = tenantContext;

router.use(EmployeeAuthMiddleware, requireTenant, requireCapability(CAPABILITIES.READ));

const ROW_LIMIT = 5;
const GRN_SCAN_CAP = 300;

// Run one section producer; a failure becomes an explicit "unavailable" section
// (with a reason) instead of a silent zero, and never fails the whole home.
async function section(reason, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[overview-operations] section failed: ${reason}:`, e.message);
    return { available: false, unavailableReason: reason };
  }
}

const RES = "/store/dashboard/operations/reservations";
const PO = "/store/dashboard/operations/purchase-order";

router.get("/", async (req, res) => {
  try {
    const companyId = req.tenant.companyId;
    const co = { companyId };                                  // direct company scope
    const coFilter = { ...tenantContext.tenantFilter(req.tenant) }; // legacy-safe scope

    const mrfDetail = (id) => `/store/dashboard/order-requests/mrf/${id}`;
    const poDetail = (id) => `${PO}/${id}`;

    const [
      requestsToClassify,
      quotationsActive,
      posToIssue,
      posToReceive,
      reservationShortages,
      readyToPick,
      partlyIssued,
      serviceAcceptance,
      openStockCounts,
      receiving,
    ] = await Promise.all([

      // ── Requests the store has approved but not yet reviewed ──────────────
      section("Material requests could not be read.", async () => {
        const q = { ...coFilter, status: "APPROVED", storeReviewedAt: null };
        const [count, rows] = await Promise.all([
          MRF.countDocuments(q),
          MRF.find(q).select("mrfNumber requestedForName requestedForDept neededBy createdAt")
            .sort({ neededBy: 1, createdAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.mrfNumber || "—", who: r.requestedForName || "", dept: r.requestedForDept || "", neededBy: r.neededBy || null, href: mrfDetail(r._id) })),
          hasMore: count > rows.length,
          href: "/store/dashboard/order-requests",
          source: "Material requests approved and not yet reviewed by the store",
        };
      }),

      // ── Active supplier quotations (live offers to compare) ───────────────
      section("Supplier quotations could not be read.", async () => {
        const q = { ...co, status: "ACTIVE" };
        const [count, rows] = await Promise.all([
          SupplierOffer.countDocuments(q),
          SupplierOffer.find(q).select("supplierName validUntil createdAt").sort({ createdAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.supplierName || "Supplier", validUntil: r.validUntil || null, href: "/store/dashboard/supplier-offers" })),
          hasMore: count > rows.length,
          href: "/store/dashboard/supplier-offers",
          source: "Supplier offers in ACTIVE state",
        };
      }),

      // ── Purchase orders drafted but not issued ────────────────────────────
      section("Purchase orders could not be read.", async () => {
        const q = { ...co, status: "DRAFT" };
        const [count, rows] = await Promise.all([
          PurchaseOrder.countDocuments(q),
          PurchaseOrder.find(q).select("poNumber vendorName createdAt").sort({ createdAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.poNumber || "—", supplier: r.vendorName || "", createdAt: r.createdAt || null, href: poDetail(r._id) })),
          hasMore: count > rows.length,
          href: `${PO}?status=DRAFT`,
          source: "Purchase orders in DRAFT (not yet issued)",
        };
      }),

      // ── Issued / partly-received orders awaiting delivery ─────────────────
      section("Purchase orders could not be read.", async () => {
        const q = { ...co, status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } };
        const [count, rows] = await Promise.all([
          PurchaseOrder.countDocuments(q),
          PurchaseOrder.find(q).select("poNumber vendorName status createdAt").sort({ createdAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.poNumber || "—", supplier: r.vendorName || "", state: r.status === "PARTIALLY_RECEIVED" ? "Partly received" : "Issued", href: poDetail(r._id) })),
          hasMore: count > rows.length,
          href: PO,
          source: "Purchase orders in ISSUED or PARTIALLY_RECEIVED",
        };
      }),

      // ── Reservation shortages (backorder) — a purchasing signal ───────────
      section("Reservations could not be read.", async () => {
        const q = { ...co, active: true, backorderedQty: { $gt: 0 } };
        const [count, rows] = await Promise.all([
          StockReservation.countDocuments(q),
          StockReservation.find(q).select("mrfNumber mrfId itemName sku unit requestedQty reservedQty backorderedQty requestedForDept")
            .sort({ updatedAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.mrfNumber || "—", item: r.itemName || "", unit: r.unit || "", requested: r.requestedQty, reserved: r.reservedQty, backordered: r.backorderedQty, href: r.mrfId ? mrfDetail(r.mrfId) : null })),
          hasMore: count > rows.length,
          href: `${RES}?group=BACKORDERED`,
          source: "Active reservations with a backordered quantity",
        };
      }),

      // ── Fully reserved, ready to pick ─────────────────────────────────────
      section("Reservations could not be read.", async () => {
        const q = { ...co, active: true, status: "RESERVED" };
        const [count, rows] = await Promise.all([
          StockReservation.countDocuments(q),
          StockReservation.find(q).select("mrfNumber mrfId itemName unit reservedQty requestedForDept")
            .sort({ updatedAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.mrfNumber || "—", item: r.itemName || "", unit: r.unit || "", reserved: r.reservedQty, href: r.mrfId ? mrfDetail(r.mrfId) : null })),
          hasMore: count > rows.length,
          href: `${RES}?group=READY_TO_PICK`,
          source: "Reservations fully reserved and not yet issued (status RESERVED)",
        };
      }),

      // ── Partly issued reservations (more still to issue) ──────────────────
      section("Reservations could not be read.", async () => {
        const q = { ...co, active: true, status: "PARTIALLY_ISSUED" };
        const count = await StockReservation.countDocuments(q);
        return {
          available: true, count, capped: false, rows: [], hasMore: count > 0,
          href: `${RES}?group=PARTLY_ISSUED`,
          source: "Reservations with some quantity issued and more outstanding",
        };
      }),

      // ── Service work reported done, awaiting requester acceptance ─────────
      section("Service orders could not be read.", async () => {
        const q = { ...co, status: "COMPLETION_REPORTED" };
        const [count, rows] = await Promise.all([
          ServiceOrder.countDocuments(q),
          ServiceOrder.find(q).select("serviceOrderNumber vendorName title createdAt").sort({ createdAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.serviceOrderNumber || "—", supplier: r.vendorName || "", title: r.title || "", href: `/store/dashboard/operations/service-orders/${r._id}` })),
          hasMore: count > rows.length,
          href: "/store/dashboard/operations/service-orders",
          source: "Service orders in COMPLETION_REPORTED (awaiting acceptance)",
        };
      }),

      // ── Open stock counts requiring completion or review ──────────────────
      section("Stock counts could not be read.", async () => {
        const q = { ...co, status: { $in: StockCount.OPEN_STATUSES } };
        const [count, rows] = await Promise.all([
          StockCount.countDocuments(q),
          StockCount.find(q).select("countNumber warehouseName status createdAt").sort({ createdAt: -1 }).limit(ROW_LIMIT).lean(),
        ]);
        return {
          available: true, count, capped: false,
          rows: rows.map((r) => ({ id: String(r._id), ref: r.countNumber || "—", warehouse: r.warehouseName || "", state: r.status, href: "/store/dashboard/raw-items/stock-count" })),
          hasMore: count > rows.length,
          href: "/store/dashboard/raw-items/stock-count",
          source: "Stock counts in DRAFT / IN_PROGRESS / REVIEWED",
        };
      }),

      // ── Receiving: awaiting inspection + put-away (bounded derived scan) ───
      // Stage is DERIVED (no stored status), so this inspects the newest N
      // recorded receipts and discloses truncation — never a false total.
      section("Goods receipts could not be read.", async () => {
        const filter = { ...coFilter, status: "RECORDED" };
        const storedMatchCount = await GoodsReceipt.countDocuments(filter);
        const docs = await GoodsReceipt.find(filter)
          .select("receiptNumber poNumber purchaseOrderId supplierName receiptDate lines createdAt")
          .sort({ receiptDate: -1, _id: -1 }).limit(GRN_SCAN_CAP).lean();
        const ids = docs.map((d) => d._id);
        const poIds = [...new Set(docs.map((d) => d.purchaseOrderId).filter(Boolean).map(String))];
        const [inspections, putaways, dispositions, pos] = await Promise.all([
          ids.length ? GoodsReceiptInspection.find({ companyId, goodsReceiptId: { $in: ids } }).lean() : [],
          ids.length ? GoodsReceiptPutaway.find({ companyId, goodsReceiptId: { $in: ids } }).lean() : [],
          ids.length ? GoodsReceiptDisposition.find({ companyId, goodsReceiptId: { $in: ids } }).lean() : [],
          poIds.length ? PurchaseOrder.find({ _id: { $in: poIds }, ...coFilter }).select("returnRequests").lean() : [],
        ]);
        const inspByGrn = new Map(inspections.map((i) => [String(i.goodsReceiptId), i]));
        const group = (rows) => { const m = new Map(); for (const r of rows) { const k = String(r.goodsReceiptId); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
        const putawaysByGrn = group(putaways);
        const dispsByGrn = group(dispositions);
        const returnsByGrn = new Map();
        for (const po of pos) for (const r of (po.returnRequests || [])) { if (!r.goodsReceiptId) continue; const k = String(r.goodsReceiptId); if (!returnsByGrn.has(k)) returnsByGrn.set(k, []); returnsByGrn.get(k).push(r); }

        const inspect = [], putaway = [];
        for (const g of docs) {
          const k = String(g._id);
          const c = control.deriveControl(g, inspByGrn.get(k) || null, putawaysByGrn.get(k) || [], {}, { dispositions: dispsByGrn.get(k) || [], supplierReturns: returnsByGrn.get(k) || [] });
          const row = { id: k, ref: g.receiptNumber || "—", po: g.poNumber || "", supplier: g.supplierName || "", href: "/store/dashboard/operations/goods-receipts" };
          if (c.flags.awaitingInspection) inspect.push(row);
          else if (c.flags.awaitingPutaway) putaway.push(row);
        }
        const capped = storedMatchCount > GRN_SCAN_CAP;
        return {
          receiptsToInspect: {
            available: true, count: inspect.length, capped, rows: inspect.slice(0, ROW_LIMIT), hasMore: inspect.length > ROW_LIMIT,
            href: "/store/dashboard/operations/goods-receipts",
            source: capped ? `Recorded receipts awaiting inspection (newest ${GRN_SCAN_CAP} scanned)` : "Recorded receipts awaiting inspection",
          },
          putawayPending: {
            available: true, count: putaway.length, capped, rows: putaway.slice(0, ROW_LIMIT), hasMore: putaway.length > ROW_LIMIT,
            href: "/store/dashboard/operations/goods-receipts",
            source: capped ? `Accepted receipts awaiting put-away (newest ${GRN_SCAN_CAP} scanned)` : "Accepted receipts awaiting put-away",
          },
        };
      }),
    ]);

    // The two receiving queues share one scan; if it failed, both are unavailable.
    const receiptsToInspect = receiving.receiptsToInspect || { available: false, unavailableReason: receiving.unavailableReason || "Goods receipts could not be read." };
    const putawayPending = receiving.putawayPending || { available: false, unavailableReason: receiving.unavailableReason || "Goods receipts could not be read." };

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      company: { resolved: true },
      sections: {
        requestsToClassify,
        quotationsActive,
        posToIssue,
        posToReceive,
        receiptsToInspect,
        putawayPending,
        reservationShortages,
        readyToPick,
        partlyIssued,
        serviceAcceptance,
        openStockCounts,
        // Purchase/bill-match exceptions are an expensive per-order reconciliation
        // (computed in their own workspace). The home links there rather than
        // re-running that scan on every load — a door, not a fabricated number.
        exceptions: { available: true, linkOnly: true, href: "/store/dashboard/operations/purchase-exceptions", source: "Purchase exceptions register (computed in its workspace)" },
        // Inventory-integrity exceptions are their own workspace and are kept
        // SEPARATE from purchase/bill-match exceptions — never a combined count.
        stockExceptions: { available: true, linkOnly: true, href: "/store/dashboard/operations/stock-exceptions", source: "Stock exceptions workspace (inventory integrity)" },
      },
    });
  } catch (error) {
    console.error("[overview-operations] failed:", error);
    res.status(500).json({ success: false, message: "The operational overview could not be read." });
  }
});

module.exports = router;
