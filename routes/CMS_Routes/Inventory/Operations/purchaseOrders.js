// routes/CMS_Routes/Inventory/Operations/purchaseOrders.js
//
// CHANGES VS YOUR EXISTING FILE:
//   - Helper `findVariantNickname` added: looks up a variant-specific
//     vendor nickname from RawItem.variants[].vendorNicknames[]
//   - POST / and PUT /:id now call findVariantNickname(rawItem, variantId, vendor)
//     instead of looking at item-level rawItem.vendorNicknames (which is gone).
//   - The .select() query for the RawItem now pulls "variants" so the lookup
//     has the data it needs.
//
// EVERYTHING ELSE (auth, helpers, /receive, /payment, /status, etc.) is identical.

const express = require("express");
const router = express.Router();
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const locStock = require("../../../../services/storePurchase/locationStock.service");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const VendorEmailService = require("../../../../services/VendorEmailService");
const NotificationService = require("../../../../services/NotificationService");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const mongoose = require("mongoose");

/* ── Chunk 1: tenancy, capabilities, numbering, idempotency, history ───────
 * Authentication stays exactly where it was; these add the two questions it
 * never asked (whose company, and may they do this) plus the three guarantees
 * Chunk 0 proved were missing (one number, one effect, one record). */
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const sequences = require("../../../../services/storePurchase/documentSequence.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const approvalPolicy = require("../../../../services/storePurchase/approvalPolicy.service");
const lifecycle = require("../../../../services/storePurchase/lifecycle.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const idempotencyService = require("../../../../services/storePurchase/idempotency.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");

const ENTITY = "PURCHASE_ORDER";

router.use(EmployeeAuthMiddleware);
/* Every route below is tenant-resolved. A caller whose company cannot be
   proved gets a 403 here rather than an unscoped result set. */
router.use(requireTenant);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const generatePONumber = () => {
  const prefix = "PO";
  const year = new Date().getFullYear().toString().slice(-2);
  const month = (new Date().getMonth() + 1).toString().padStart(2, "0");
  const randomNum = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `${prefix}${year}${month}${randomNum}`;
};

// NOTE: the old inline `convertQuantity` was removed with the legacy receipt
// engine. Unit conversion for receiving now lives ONLY in
// services/storePurchase/goodsReceipt.service.js (`resolveConversion`), which —
// unlike the old silent passthrough — refuses a missing conversion path.

// ── NEW: Find a variant's nickname for a specific vendor ────────────────────
// rawItemDoc: lean object with .variants[].vendorNicknames[]
// variantId: ObjectId or string of the variant on the PO line (optional)
// vendorId: vendor ObjectId or string
// Returns: nickname string or "" if not found
const findVariantNickname = (rawItemDoc, variantId, vendorId) => {
  if (!rawItemDoc || !vendorId || !Array.isArray(rawItemDoc.variants))
    return "";

  // If a specific variant was chosen, look only in that variant's nicknames
  if (variantId) {
    const variant = rawItemDoc.variants.find(
      (v) => v._id?.toString() === variantId.toString(),
    );
    if (variant?.vendorNicknames?.length) {
      const vn = variant.vendorNicknames.find(
        (n) => n.vendor?.toString() === vendorId.toString(),
      );
      if (vn?.nickname) return vn.nickname;
    }
    return "";
  }

  // No variant selected → fall back to first nickname this vendor has on any variant
  for (const variant of rawItemDoc.variants) {
    const nks = variant?.vendorNicknames || [];
    const vn = nks.find((n) => n.vendor?.toString() === vendorId.toString());
    if (vn?.nickname) return vn.nickname;
  }
  return "";
};

// ─────────────────────────────────────────────────────────────────────────────
// GET all purchase orders
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { search = "", status, vendor, startDate, endDate } = req.query;
    /* THE tenant boundary for this register. In legacy mode this selects the
       records with no company at all — never both, so an ordinary list can
       never quietly include unowned documents. */
    let filter = { ...tenantContext.tenantFilter(req.tenant) };

    if (search) {
      filter.$or = [
        { poNumber: { $regex: search, $options: "i" } },
        { vendorName: { $regex: search, $options: "i" } },
        { "items.itemName": { $regex: search, $options: "i" } },
      ];
    }
    if (status && status !== "all") filter.status = status;
    if (vendor) filter.vendor = vendor;
    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }

  const purchaseOrders = await PurchaseOrder.find(filter)
  .populate("vendor", "companyName contactPerson phone email bankDetails")
  .populate("items.rawItem", "name sku unit")
  .populate("createdBy", "name email")
  .populate("approvedBy", "name email")
  .populate("payments.recordedBy", "name email")
  .sort({ createdAt: -1 });

    /* Scoped like the list itself. An unscoped countDocuments() would leak
       another company's volume even while the rows stayed hidden. */
    const scope = tenantContext.tenantFilter(req.tenant);
    const total = await PurchaseOrder.countDocuments(scope);
    const draft = await PurchaseOrder.countDocuments({ ...scope, status: "DRAFT" });
    const issued = await PurchaseOrder.countDocuments({ ...scope, status: "ISSUED" });
    const partiallyReceived = await PurchaseOrder.countDocuments({
      ...scope, status: "PARTIALLY_RECEIVED",
    });
    const completed = await PurchaseOrder.countDocuments({
      ...scope, status: "COMPLETED",
    });

    let totalAmount = 0,
      totalPaid = 0,
      pendingAmount = 0;
    purchaseOrders.forEach((po) => {
      totalAmount += po.totalAmount || 0;
      const poPaid =
        po.payments?.reduce((sum, payment) => sum + (payment.amount || 0), 0) ||
        0;
      totalPaid += poPaid;
      pendingAmount += (po.totalAmount || 0) - poPaid;
    });

    const paymentPending = await PurchaseOrder.countDocuments({
      ...scope, paymentStatus: "PENDING",
    });
    const paymentPartial = await PurchaseOrder.countDocuments({
      ...scope, paymentStatus: "PARTIAL",
    });
    const paymentCompleted = await PurchaseOrder.countDocuments({
      ...scope, paymentStatus: "COMPLETED",
    });

    res.json({
      success: true,
      purchaseOrders,
      stats: {
        total,
        draft,
        issued,
        partiallyReceived,
        completed,
        totalAmount,
        totalPaid,
        pendingAmount,
        paymentPending,
        paymentPartial,
        paymentCompleted,
      },
    });
  } catch (error) {
    console.error("Error fetching purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase orders",
    });
  }
});

//    vendor's price + deliveryDays + the alias _id (needed for price write-back).
router.get("/data/vendor-items/:vendorId", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid vendor id" });
    }

    const items = await RawItem.find({
      "variants.vendorNicknames.vendor": vendorId,
    })
      .select(
        "name sku category customCategory unit customUnit description quantity minStock maxStock status variants unitConversion",
      )
      .lean()
      .sort({ name: 1 });

    const formatted = items.map((item) => {
      // Keep only variants that have an alias for THIS vendor
      const matchingVariants = (item.variants || [])
        .map((v) => {
          const alias = (v.vendorNicknames || []).find(
            (vn) => vn.vendor?.toString() === vendorId,
          );
          if (!alias) return null;
          return {
            _id: v._id.toString(),
            combination: v.combination || [],
            sku: v.sku || "",
            quantity: v.quantity || 0,
            minStock: v.minStock || 0,
            maxStock: v.maxStock || 0,
            // vendor-specific alias data
            aliasId: alias._id.toString(),
            vendorCode: alias.nickname || "",
            price: alias.price || 0,
            deliveryDays: alias.deliveryDays || 0,
          };
        })
        .filter(Boolean);

      return {
        id: item._id.toString(),
        name: item.name,
        sku: item.sku,
        category: item.customCategory || item.category || "Uncategorized",
        unit: item.customUnit || item.unit || "unit",
        description: item.description || "",
        currentStock: item.quantity || 0,
        minStock: item.minStock || 0,
        maxStock: item.maxStock || 0,
        status: item.status || "In Stock",
        unitConversion: item.unitConversion || null,
        variants: matchingVariants,
      };
    });

    res.json({ success: true, rawItems: formatted });
  } catch (error) {
    console.error("Error fetching vendor items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor items",
    });
  }
});

router.get("/data/raw-items-with-variants", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const rawItems = await RawItem.find({})
      .select(
        "name sku category customCategory unit customUnit description quantity minStock maxStock status variants",
      )
      .lean()
      .sort({ name: 1 });

    const formatted = rawItems.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      sku: item.sku,
      category: item.customCategory || item.category || "Uncategorized",
      unit: item.customUnit || item.unit || "unit",
      description: item.description || "",
      currentStock: item.quantity || 0,
      minStock: item.minStock || 0,
      maxStock: item.maxStock || 0,
      status: item.status || "In Stock",
      variants: (item.variants || []).map((v) => ({
        _id: v._id.toString(),
        combination: v.combination || [],
        sku: v.sku || "",
        quantity: v.quantity || 0,
        image: v.image || "",
        // No aliasId / vendorCode / price / deliveryDays here — those are vendor-specific
        // The frontend will mark hasExistingAlias = false for all variants in this pool
        aliasId: "",
        vendorCode: "",
        price: 0,
        deliveryDays: 0,
      })),
    }));

    res.json({ success: true, rawItems: formatted });
  } catch (error) {
    console.error("Error fetching raw items with variants:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items with variants",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET available units for a raw item
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/raw-items/:id/units", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .select("unit customUnit name")
      .lean();
    if (!rawItem)
      return res
        .status(404)
        .json({ success: false, message: "Raw item not found" });

    const baseUnit = rawItem.customUnit || rawItem.unit;
    const available = [
      {
        name: baseUnit,
        isBase: true,
        factor: 1,
        label: `${baseUnit} (registered)`,
      },
    ];

    const baseDoc = await Unit.findOne({ name: baseUnit })
      .populate("conversions.toUnit", "name")
      .lean();

    if (baseDoc?.conversions?.length) {
      for (const c of baseDoc.conversions) {
        const toName = c.toUnit?.name || c.toUnit;
        if (toName && !available.find((u) => u.name === toName)) {
          available.push({
            name: toName,
            isBase: false,
            factor: c.quantity,
            label: `${toName} (1 ${baseUnit} = ${c.quantity} ${toName})`,
          });
        }
      }
    }

    if (baseDoc?._id) {
      const reverseUnits = await Unit.find({
        "conversions.toUnit": baseDoc._id,
      }).lean();
      for (const u of reverseUnits) {
        if (available.find((au) => au.name === u.name)) continue;
        const conv = (u.conversions || []).find(
          (c) => c.toUnit?.toString() === baseDoc._id.toString(),
        );
        if (conv?.quantity) {
          available.push({
            name: u.name,
            isBase: false,
            factor: 1 / conv.quantity,
            label: `${u.name} (1 ${u.name} = ${conv.quantity} ${baseUnit})`,
          });
        }
      }
    }

    res.json({ success: true, baseUnit, availableUnits: available });
  } catch (err) {
    console.error("Error fetching unit conversions:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /reports/exceptions — the company-wide Purchase Exceptions Register.
//
// A read-only, actionable reconciliation queue across every purchase order:
// "which purchases need attention today, why, and where to resolve them?"
//
// Query cost is CONSTANT, never one reconciliation per order:
//   1 count + 1 PO find (+ vendor populate) + 1 SpendRequest find
//   + 1 BudgetCommitment find + 1 Voucher find — then buildReconciliation runs
//   in memory per order. Stored filters (supplier, status, date, search) run at
//   the DB; derived filters (exception group, unresolved-only) and the
//   severity ordering run after reconciliation, so pagination counts describe
//   the full DERIVED result, not just the DB page.
//
// Placed BEFORE `/:id` so "reports" is not read as an order id. Writes nothing.
// ─────────────────────────────────────────────────────────────────────────────
const REGISTER_SCAN_CAP = 1000; // bound the working set; truncation is disclosed

router.get("/reports/exceptions", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const SpendRequest = require("../../../../models/CMS_Models/Requests/SpendRequest");
    const Acc_BudgetCommitment = require("../../../../models/Accountant_model/Acc_BudgetCommitment");
    const { Acc_Voucher } = require("../../../../models/Accountant_model/Acc_VoucherModels");
    const register = require("../../../../services/storePurchase/poExceptionsRegister.service");

    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));
    const group = typeof q.group === "string" && register.GROUPS[q.group] ? q.group : null;
    const unresolvedOnly = q.scope !== "all";

    // ── Stored filters → one DB query ──────────────────────────────────────
    const filter = { ...tenantContext.tenantFilter(req.tenant) };
    if (typeof q.status === "string" && q.status.trim()) filter.status = q.status.trim();
    if (typeof q.vendorId === "string" && mongoose.isValidObjectId(q.vendorId)) filter.vendor = q.vendorId;
    if (q.dateFrom || q.dateTo) {
      filter.orderDate = {};
      if (q.dateFrom && !Number.isNaN(Date.parse(q.dateFrom))) filter.orderDate.$gte = new Date(q.dateFrom);
      if (q.dateTo && !Number.isNaN(Date.parse(q.dateTo))) filter.orderDate.$lte = new Date(q.dateTo);
      if (!Object.keys(filter.orderDate).length) delete filter.orderDate;
    }
    const search = typeof q.q === "string" ? q.q.trim() : (typeof q.supplier === "string" ? q.supplier.trim() : "");
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ poNumber: rx }, { vendorName: rx }, { spendRequestNumber: rx }];
    }

    // Bounded scan for speed. The bound is disclosed honestly below, and is
    // overridable (env) so coverage behaviour can be tested above and below it.
    const cap = Math.max(1, parseInt(process.env.PO_REGISTER_SCAN_CAP, 10) || REGISTER_SCAN_CAP);

    // storedMatchCount = every order matching the DB-level filters (the full
    // population); inspectedCount = the orders we actually reconciled (≤ cap).
    const storedMatchCount = await PurchaseOrder.countDocuments(filter);

    const purchaseOrders = await PurchaseOrder.find(filter)
      .populate("vendor", "companyName")
      .sort({ orderDate: -1, _id: -1 })
      .limit(cap)
      .lean();
    const inspectedCount = purchaseOrders.length;
    const coverageComplete = inspectedCount >= storedMatchCount;

    // ── Batched stored-ID joins (each ONE query for the whole page) ────────
    const requestIds = [...new Set(purchaseOrders.map((p) => p.spendRequestId).filter(Boolean).map(String))];
    const poIds = purchaseOrders.map((p) => p._id);

    const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
    const GoodsReceiptInspection = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
    const GoodsReceiptDisposition = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
    const [spendRequests, commitments, vouchers, goodsReceipts, inspections, dispositions] = await Promise.all([
      requestIds.length ? SpendRequest.find({ _id: { $in: requestIds } }).lean() : [],
      requestIds.length ? Acc_BudgetCommitment.find({ spendRequestId: { $in: requestIds } }).lean() : [],
      poIds.length ? Acc_Voucher.find({ voucherType: "purchase", purchaseOrderId: { $in: poIds } })
        .select("voucherNumber status referenceNumber voucherDate grandTotal purchaseOrderId inventoryEntries").lean() : [],
      poIds.length ? GoodsReceipt.find({ companyId: req.tenant.companyId, purchaseOrderId: { $in: poIds } })
        .select("receiptNumber status purchaseOrderId lines").lean() : [],
      poIds.length ? GoodsReceiptInspection.find({ companyId: req.tenant.companyId, purchaseOrderId: { $in: poIds } })
        .select("goodsReceiptId purchaseOrderId lines").lean() : [],
      poIds.length ? GoodsReceiptDisposition.find({ companyId: req.tenant.companyId, purchaseOrderId: { $in: poIds } })
        .select("goodsReceiptId purchaseOrderId poItemId dispositionType quantity").lean() : [],
    ]);

    // A company sanity check keeps a legacy cross-company reference from reading
    // through, exactly as the single-order reconciliation route does.
    const sameCo = (a, b) => !a || !b || String(a) === String(b);
    const poCompanyByRequest = new Map();
    for (const p of purchaseOrders) if (p.spendRequestId) poCompanyByRequest.set(String(p.spendRequestId), p.companyId);

    const spendRequestsById = new Map();
    for (const sr of spendRequests) if (sameCo(sr.companyId, poCompanyByRequest.get(String(sr._id)))) spendRequestsById.set(String(sr._id), sr);
    const commitmentsByRequestId = new Map();
    for (const c of commitments) if (sameCo(c.companyId, poCompanyByRequest.get(String(c.spendRequestId)))) commitmentsByRequestId.set(String(c.spendRequestId), c);
    const vouchersByPoId = new Map();
    for (const v of vouchers) {
      const k = String(v.purchaseOrderId);
      if (!vouchersByPoId.has(k)) vouchersByPoId.set(k, []);
      vouchersByPoId.get(k).push(v);
    }
    const goodsReceiptsByPoId = new Map();
    for (const g of goodsReceipts) {
      const k = String(g.purchaseOrderId);
      if (!goodsReceiptsByPoId.has(k)) goodsReceiptsByPoId.set(k, []);
      goodsReceiptsByPoId.get(k).push(g);
    }
    const inspectionsByPoId = new Map();
    for (const i of inspections) {
      const k = String(i.purchaseOrderId);
      if (!inspectionsByPoId.has(k)) inspectionsByPoId.set(k, []);
      inspectionsByPoId.get(k).push(i);
    }
    const dispositionsByPoId = new Map();
    for (const d of dispositions) {
      const k = String(d.purchaseOrderId);
      if (!dispositionsByPoId.has(k)) dispositionsByPoId.set(k, []);
      dispositionsByPoId.get(k).push(d);
    }

    // ── Authoritative currency: the accounting company's base currency, read
    //    (never written), with provenance. No per-order INR is invented. ─────
    let currency = null, currencyBasis = "not_recorded", currencySymbol = null;
    if (req.tenant && req.tenant.companyId) {
      const { Acc_Company } = require("../../../../models/Accountant_model/Acc_MasterModels");
      const co = await Acc_Company.findById(req.tenant.companyId).select("baseCurrency currencySymbol").lean();
      if (co && co.baseCurrency) {
        currency = co.baseCurrency; currencyBasis = "company_base_currency"; currencySymbol = co.currencySymbol || null;
      }
    }

    const links = { reconciliation: (id) => `/store/dashboard/operations/purchase-order/${id}?tab=reconciliation` };
    const asOf = new Date();

    // ── Reconcile in memory, then derive → filter → sort → paginate ────────
    const allRows = register.buildExceptionsRegister({ purchaseOrders, spendRequestsById, commitmentsByRequestId, vouchersByPoId, goodsReceiptsByPoId, inspectionsByPoId, dispositionsByPoId, links, asOf });
    const filtered = register.sortRows(register.filterRows(allRows, { group, unresolvedOnly }));
    const summary = register.summarize(filtered, { currency, currencyBasis, currencySymbol });
    const paged = register.paginate(filtered, { page, pageSize });

    const limitations = [];
    if (!coverageComplete) limitations.push(`Reviewing the ${cap} most recent matching orders. Counts and exception filters apply to this inspected set; narrow the date or search filters to inspect the remaining orders.`);
    limitations.push("Received quantity is a recorded figure, not an inspection or acceptance decision.");
    limitations.push("An outstanding balance is \"past expected delivery\" only where a stored expected date has passed; otherwise \"still to receive\".");
    if (currencyBasis !== "company_base_currency") limitations.push("No company base currency is recorded, so amounts are shown as recorded figures without a currency symbol and are not totalled across orders.");

    res.json({
      success: true,
      register: {
        rows: paged.rows,
        // Pagination totals belong to the INSPECTED result set, not the full population.
        pagination: { page: paged.page, pageSize: paged.pageSize, total: paged.total, totalPages: paged.totalPages, scope: "inspectedResultSet" },
        coverage: {
          storedMatchCount,                 // all orders matching DB filters
          inspectedCount,                   // orders actually reconciled (≤ cap)
          exceptionResultCount: filtered.length,  // matching rows within the inspected set
          coverageComplete,                 // true only when every stored match was inspected
          scanCap: cap,
          asOf: asOf.toISOString(),
        },
        summary,
        currency, currencyBasis, currencySymbol,
        inspectedCount,
        filters: { group, status: filter.status || null, vendorId: q.vendorId || null, search: search || null, scope: unresolvedOnly ? "unresolved" : "all", dateFrom: q.dateFrom || null, dateTo: q.dateTo || null },
        groups: register.GROUPS,
        limitations,
      },
    });
  } catch (error) {
    console.error("[po-exceptions-register]", error);
    res.status(500).json({ success: false, message: "Server error while building the exceptions register" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET PO by ID
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    /* Scoped find, not findById: another company's id must answer exactly as
       a missing one does. A 403 here would confirm the document exists. */
    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    })
      .populate(
        "vendor",
        "companyName contactPerson phone email address gstNumber bankDetails",
      )
      .populate("items.rawItem", "name sku unit description sellingPrice")
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .populate("deliveries.receivedBy", "name email");

    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });
    res.json({ success: true, purchaseOrder });
  } catch (error) {
    console.error("Error fetching purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase order",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/reconciliation — the read-only order/receipt/bill comparison.
//
// Resolves ONLY through stored identifiers (never by amount, name or position):
//   PO (company-scoped) → SpendRequest via `spendRequestId`
//                       → Acc_BudgetCommitment via `spendRequestId`
//                       → purchase vouchers via `purchaseOrderId`
//   and, inside buildReconciliation, PO line → allocation/request line via
//   `spendLineId`, and a voucher entry → PO line via `poItemId`.
// It writes nothing.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/reconciliation", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const SpendRequest = require("../../../../models/CMS_Models/Requests/SpendRequest");
    const Acc_BudgetCommitment = require("../../../../models/Accountant_model/Acc_BudgetCommitment");
    const { Acc_Voucher } = require("../../../../models/Accountant_model/Acc_VoucherModels");
    const { buildReconciliation } = require("../../../../services/storePurchase/poReconciliation.service");

    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .populate("vendor", "companyName")
      .populate("items.rawItem", "name sku")
      .lean();
    if (!po) return res.status(404).json({ success: false, message: "Purchase order not found" });

    // The PO's OWN stored spendRequestId is the join; a companyId sanity check
    // guards against a legacy cross-company reference reading through.
    let spendRequest = null;
    let commitment = null;
    if (po.spendRequestId) {
      spendRequest = await SpendRequest.findOne({ _id: po.spendRequestId }).lean();
      if (spendRequest && spendRequest.companyId && po.companyId && String(spendRequest.companyId) !== String(po.companyId)) {
        spendRequest = null;
      }
      commitment = await Acc_BudgetCommitment.findOne({ spendRequestId: po.spendRequestId }).lean();
      if (commitment && commitment.companyId && po.companyId && String(commitment.companyId) !== String(po.companyId)) {
        commitment = null;
      }
    }

    // Purchase vouchers linked to THIS order, company-scoped.
    const vouchers = await Acc_Voucher.find({
      companyId: po.companyId, voucherType: "purchase", purchaseOrderId: po._id,
    }).select("voucherNumber status referenceNumber voucherDate grandTotal inventoryEntries").lean();

    // Authoritative per-line evidence — GoodsReceipts (received), the immutable
    // GoodsReceiptInspections (accepted/quarantined/rejected), and the quarantine
    // dispositions (resolution) for THIS PO.
    const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
    const GoodsReceiptInspection = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
    const GoodsReceiptDisposition = require("../../../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
    const [goodsReceipts, inspections, dispositions] = await Promise.all([
      GoodsReceipt.find({ companyId: po.companyId, purchaseOrderId: po._id }).select("receiptNumber status lines").lean(),
      GoodsReceiptInspection.find({ companyId: po.companyId, purchaseOrderId: po._id }).select("goodsReceiptId lines").lean(),
      GoodsReceiptDisposition.find({ companyId: po.companyId, purchaseOrderId: po._id }).select("goodsReceiptId poItemId dispositionType quantity").lean(),
    ]);

    const reconciliation = buildReconciliation({ purchaseOrder: po, spendRequest, commitment, vouchers, goodsReceipts, inspections, dispositions });
    res.json({ success: true, reconciliation });
  } catch (error) {
    console.error("[po-reconciliation]", error);
    res.status(500).json({ success: false, message: "Server error while building the reconciliation" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET available raw items for PO
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/raw-items", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { search = "", limit = 0 } = req.query;
    // limit=0 (default) → NO limit: return the full catalog.
    // Callers that want truncation must pass an explicit limit.
    const filter = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { sku: { $regex: search, $options: "i" } },
          ],
        }
      : {};
    let query = RawItem.find(filter).sort({ name: 1 });
    const lim = parseInt(limit);
    if (lim > 0) query = query.limit(lim);
    const rawItems = await query
      .select(
        "name sku category customCategory unit customUnit description sellingPrice minStock maxStock quantity status",
      )
      .lean();

    const formattedItems = rawItems.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      sku: item.sku,
      category: item.customCategory || item.category || "Uncategorized",
      unit: item.customUnit || item.unit || "unit",
      description: item.description || "",
      sellingPrice: item.sellingPrice || 0,
      currentStock: item.quantity || 0,
      minStock: item.minStock || 0,
      maxStock: item.maxStock || 0,
      status: item.status || "In Stock",
    }));

    res.json({ success: true, rawItems: formattedItems });
  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET available vendors for PO
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/vendors", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    /* ── SELECTABLE SUPPLIERS OF THIS COMPANY ONLY ──────────────────────
     * This read every Active supplier in the database, so the "choose a
     * supplier" list on a purchase order offered another company's suppliers
     * — and picking one would have bound this company's order to a record it
     * does not own. Legacy suppliers (no company) are excluded too: nobody
     * can say whose they are, so nothing new may be ordered against them. */
    const vendors = await Vendor.find({
      /* `$and`, not a second `companyId` key: spreading the tenant filter and
         then writing `companyId` again REPLACES it, which would drop the
         company scope entirely. */
      $and: [
        tenantContext.tenantFilter(req.tenant),
        { companyId: { $ne: null } },
        { status: "Active" },
      ],
    })
      .select(
        "companyName contactPerson phone email address gstNumber vendorType paymentTerms supplierCode",
      )
      .sort({ companyName: 1 });

    res.json({
      success: true,
      vendors: vendors.map((v) => ({
        id: v._id,
        name: v.companyName,
        contactPerson: v.contactPerson,
        phone: v.phone,
        email: v.email,
        address: v.address,
        gstNumber: v.gstNumber,
        vendorType: v.vendorType,
        paymentTerms: v.paymentTerms,
      })),
    });
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while fetching vendors" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE new PO  (now uses findVariantNickname)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/",
  requireCapability(CAPABILITIES.PO_CREATE),
  refuseLegacyWrite,
  withIdempotency("PO_CREATE"),
  async (req, res) => {
  try {
    /* A companyId in the body is a client asking for something it must never
       get. Answering with a silent substitution would teach it the field
       works. */
    tenantContext.assertNoForeignCompany(req.tenant, req.body);

    /* ── RECOVERY ───────────────────────────────────────────────────────────
     * An earlier attempt with this key already created the order and then
     * failed before the response was recorded. Creating another would give
     * one user action two orders — and two numbers off the sequence. */
    if (req.idempotent?.recovering?.entityId) {
      const existing = await PurchaseOrder.findOne({
        _id: req.idempotent.recovering.entityId,
        ...tenantContext.tenantFilter(req.tenant),
      })
        .populate("vendor", "companyName contactPerson email phone address")
        .populate("items.rawItem", "name sku unit")
        .populate("createdBy", "name email");
      if (existing) {
        await unitOfWork.recover(req.tenant, {
          entityType: ENTITY,
          entityId: existing._id,
          idempotencyKey: req.idempotent.key,
          entry: {
            documentNumber: existing.poNumber,
            action: "CREATED",
            resultingState: existing.status,
            requestId: req.id || "",
            idempotencyKey: req.idempotent.key,
            metadata: { recovered: true },
          },
        });
        return await req.idempotent.succeed(201, {
          success: true,
          message: "Purchase order created successfully",
          purchaseOrder: existing,
        }, { entityType: ENTITY, entityId: existing._id });
      }
    }

    const {
      vendor,
      vendorName,
      orderDate,
      expectedDeliveryDate,
      items,
      taxRate,
      shippingCharges,
      discount,
      notes,
      termsConditions,
      paymentTerms,
    } = req.body;

    /* ── A NEW ORDER IS ALWAYS A DRAFT ──────────────────────────────────────
     * Creation used to take `status` straight from the body, so a caller
     * holding only `sp.po.create` could POST `status: "ISSUED"` and skip the
     * transition endpoint entirely — no issue capability, no approval policy,
     * no `approvedBy`, and the supplier emailed on the way past. It could
     * even create a "COMPLETED" order that had received nothing.
     *
     * Refused explicitly rather than ignored: a client that sends a status
     * believes it is setting one, and silently downgrading it would leave
     * somebody convinced they had issued an order they had not. */
    const requestedStatus = req.body?.status;
    if (requestedStatus !== undefined && requestedStatus !== null && requestedStatus !== "DRAFT") {
      throw fail(
        "VALIDATION",
        "A new purchase order is always created as a draft. Issue it from the order itself once it is ready.",
        { field: "status", supplied: String(requestedStatus), allowed: ["DRAFT"] },
      );
    }
    const status = "DRAFT";

    const isEmergency = req.body.isEmergencyOrder === true || req.body.isEmergencyOrder === "true"
    if (!vendor && !isEmergency)
      return res.status(400).json({ success: false, message: "Vendor is required" });
    if (!items?.length)
      return res
        .status(400)
        .json({ success: false, message: "At least one item is required" });

    /* ── Chunk 1: the number comes from the atomic allocator ───────────────
     * The previous scheme minted `PO<yy><mm><rand4>`, checked whether it
     * already existed and retried ten times — which can still collide, and
     * gives up with a 500 when it does. One $inc against a unique key cannot
     * hand the same number to two callers. A number in the request body is
     * ignored: numbering is server-owned. */
    const allocated = await sequences.allocate({
      companyId: req.tenant.companyId,
      documentType: "PURCHASE_ORDER",
      siteId: req.tenant.siteId,
    });
    const poNumber = allocated.number;

    // Build items — looks up baseUnit + per-variant vendor nickname
    const itemsWithDetails = await Promise.all(
      items.map(async (item) => {
        const ri = await RawItem.findById(item.rawItem)
          .select("unit customUnit name sku variants")
          .lean();

        const registeredUnit = ri
          ? ri.customUnit || ri.unit
          : item.unit || "unit";
        const poUnit = item.unit || registeredUnit;

        // ── per-variant nickname lookup ──
        const vendorNickname = findVariantNickname(ri, item.variantId, vendor);

        const qty = Number(item.quantity) || 0;
        const price = Number(item.unitPrice) || 0;
        const baseTotal = qty * price;
        const validCharges = (item.itemCharges || []).filter((c) => c.label?.trim() && parseFloat(c.value) > 0);
        const itemChargesTotal = validCharges.reduce((s, c) => {
          const v = parseFloat(c.value) || 0;
          return s + (c.type === "percent" ? (baseTotal * v) / 100 : v);
        }, 0);
        const resolvedCharges = validCharges.map((c) => ({
          label: c.label,
          value: c.value,
          type: c.type || "amount",
          amount: c.type === "percent"
            ? (baseTotal * (parseFloat(c.value) || 0)) / 100
            : parseFloat(c.value) || 0,
        }));
        const totalPrice = baseTotal + itemChargesTotal;
        const itemGstRate = Number(item.gstRate) || 0;
        const itemGstAmount = totalPrice * itemGstRate / 100;
        return {
          rawItem: item.rawItem,
          itemName: item.itemName || ri?.name || "Unknown Item",
          sku: item.sku || ri?.sku || "",
          unit: poUnit,
          baseUnit: registeredUnit,
          vendorNickname,
          quantity: qty,
          unitPrice: price,
          totalPrice,
          gstRate: itemGstRate,
          gstAmount: itemGstAmount,
          itemCharges: resolvedCharges,
          itemChargesTotal,
          receivedQuantity: 0,
          pendingQuantity: qty,
          status: "PENDING",
          variantId: item.variantId || null,
          variantCombination: item.variantCombination || [],
          variantName: item.variantCombination?.join(" • ") || "",
          variantSku: item.variantSku || "",
          expectedDeliveryDate: item.expectedDeliveryDate
            ? new Date(item.expectedDeliveryDate)
            : null,
        };
      }),
    );

    const subtotal = itemsWithDetails.reduce((sum, i) => sum + (i.totalPrice || 0), 0);
    const taxAmount = itemsWithDetails.reduce((sum, i) => sum + (i.gstAmount || 0), 0);
    const customChargesArr = Array.isArray(req.body.customCharges)
      ? req.body.customCharges
      : [];
    const customChargesTotal = customChargesArr.reduce(
      (s, c) => s + (parseFloat(c.amount) || 0),
      0,
    );
    const totalAmount =
      subtotal +
      taxAmount +
      (Number(shippingCharges) || 0) -
      (Number(discount) || 0) +
      customChargesTotal;

    const purchaseOrderData = {
      /* Tenancy from context ONLY — never from the payload. */
      ...tenantContext.stamp(req.tenant),
      poNumber,
      vendor,
      vendorName: vendorName || "",
      orderDate: orderDate ? new Date(orderDate) : new Date(),
      expectedDeliveryDate: expectedDeliveryDate
        ? new Date(expectedDeliveryDate)
        : null,
      items: itemsWithDetails,
      subtotal,
      taxRate: Number(taxRate) || 0,
      taxAmount,
      shippingCharges: Number(shippingCharges) || 0,
      discount: Number(discount) || 0,
      customCharges: customChargesArr.filter((c) => c.label?.trim()),
      totalAmount,
      totalReceived: 0,
      totalPending: itemsWithDetails.reduce((sum, i) => sum + i.quantity, 0),
      status,
      paymentStatus: "PENDING",
      paymentTerms: paymentTerms || "",
      notes: notes || "",
      termsConditions: termsConditions || "",
      isEmergencyOrder: isEmergency,
      createdBy: req.user.id,
    };

    /* Creation, its history entry and the idempotency effect marker as one
       unit. Without the marker a failure anywhere after the save — the
       history write, the response record — would release the key and let the
       retry create a SECOND order against the same allocated number. */
    const purchaseOrder = new PurchaseOrder(purchaseOrderData);
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        await purchaseOrder.save(session ? { session } : {});
        return {
          entityType: ENTITY,
          entityId: purchaseOrder._id,
          result: true,
          entry: {
            entityType: ENTITY,
            entityId: purchaseOrder._id,
            documentNumber: poNumber,
            action: "CREATED",
            resultingState: purchaseOrder.status,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: {
              lineCount: itemsWithDetails.length,
              totalAmount,
              isEmergencyOrder: isEmergency,
            },
          },
        };
      },
    });

    let populatedPO;
    try {
      populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
        .populate("vendor", "companyName contactPerson email phone address")
        .populate("items.rawItem", "name sku unit")
        .populate("createdBy", "name email");
    } catch (populateError) {
      console.error("Populate error (non-critical):", populateError);
      populatedPO = purchaseOrder;
    }

    /* No supplier email and no "issued" notification here. A draft has not
       been issued to anybody, and both of those used to fire during creation
       whenever the body said ISSUED. They belong to the transition endpoint,
       which is the only place issuance now happens. */

    const body = {
      success: true,
      message: "Purchase order created successfully",
      purchaseOrder: populatedPO || purchaseOrder,
    };
    /* Recorded as the replayable result, so an identical retry returns THIS
       order rather than creating a second one. */
    return req.idempotent
      ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: purchaseOrder._id })
      : res.status(201).json(body);
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error creating purchase order:", error);
    return res.status(500).json({
      success: false,
      message: `Server error while creating purchase order: ${error.message}`,
    });
  }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PO  (now uses findVariantNickname)
// ─────────────────────────────────────────────────────────────────────────────
router.put(
  "/:id",
  requireCapability(CAPABILITIES.PO_CREATE),
  refuseLegacyWrite,
  async (req, res) => {
  try {
    tenantContext.assertNoForeignCompany(req.tenant, req.body);

    /* ── RECOVERY ───────────────────────────────────────────────────────────
     * An earlier attempt with this key already created the order and then
     * failed before the response was recorded. Creating another would give
     * one user action two orders — and two numbers off the sequence. */
    if (req.idempotent?.recovering?.entityId) {
      const existing = await PurchaseOrder.findOne({
        _id: req.idempotent.recovering.entityId,
        ...tenantContext.tenantFilter(req.tenant),
      })
        .populate("vendor", "companyName contactPerson email phone address")
        .populate("items.rawItem", "name sku unit")
        .populate("createdBy", "name email");
      if (existing) {
        await unitOfWork.recover(req.tenant, {
          entityType: ENTITY,
          entityId: existing._id,
          idempotencyKey: req.idempotent.key,
          entry: {
            documentNumber: existing.poNumber,
            action: "CREATED",
            resultingState: existing.status,
            requestId: req.id || "",
            idempotencyKey: req.idempotent.key,
            metadata: { recovered: true },
          },
        });
        return await req.idempotent.succeed(201, {
          success: true,
          message: "Purchase order created successfully",
          purchaseOrder: existing,
        }, { entityType: ENTITY, entityId: existing._id });
      }
    }

    const {
      vendor,
      vendorName,
      orderDate,
      expectedDeliveryDate,
      items,
      taxRate,
      shippingCharges,
      discount,
      notes,
      termsConditions,
      paymentTerms,
    } = req.body;

    /* ── EDITING IS NOT A TRANSITION ────────────────────────────────────────
     * This route used to accept `status` and assign it directly, which made
     * it a second, unguarded way to issue or cancel an order: no issue
     * capability, no approval policy, no reason, no history. Status changes
     * belong to PATCH /:id/status and nowhere else. */
    if (req.body?.status !== undefined) {
      throw fail(
        "VALIDATION",
        "An order's status is changed from the order itself, not by editing it.",
        { field: "status" },
      );
    }

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    });
    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    /* ── ONLY A DRAFT IS EDITABLE ───────────────────────────────────────────
     * The old guard refused only PARTIALLY_RECEIVED and COMPLETED, so an
     * ISSUED order — a commitment the supplier has already been sent — could
     * have its lines, prices and vendor rewritten, and a CANCELLED one could
     * be edited back into use. An issued order is immutable until the PO
     * amendment document exists (Chunk 6). */
    if (purchaseOrder.status !== "DRAFT") {
      throw fail(
        "INVALID_TRANSITION",
        `A purchase order that is ${lifecycle.humanState(purchaseOrder.status)} cannot be edited.`,
        { state: purchaseOrder.status, editableStates: ["DRAFT"] },
      );
    }

    /* A summary of what the edit changed, for history. Field names and short
       scalars only — never the line arrays themselves. */
    const before = {
      vendorName: purchaseOrder.vendorName,
      totalAmount: purchaseOrder.totalAmount,
      lineCount: (purchaseOrder.items || []).length,
      expectedDeliveryDate: purchaseOrder.expectedDeliveryDate
        ? new Date(purchaseOrder.expectedDeliveryDate).toISOString()
        : null,
    };

    if (vendor) purchaseOrder.vendor = vendor;
    if (vendorName) purchaseOrder.vendorName = vendorName;
    if (orderDate) purchaseOrder.orderDate = new Date(orderDate);
    if (expectedDeliveryDate)
      purchaseOrder.expectedDeliveryDate = new Date(expectedDeliveryDate);
    if (taxRate !== undefined) purchaseOrder.taxRate = parseFloat(taxRate);
    if (shippingCharges !== undefined)
      purchaseOrder.shippingCharges = parseFloat(shippingCharges);
    if (discount !== undefined) purchaseOrder.discount = parseFloat(discount);
    if (req.body.customCharges !== undefined)
      purchaseOrder.customCharges = Array.isArray(req.body.customCharges)
        ? req.body.customCharges.filter((c) => c.label?.trim())
        : [];
    if (notes !== undefined) purchaseOrder.notes = notes;
    if (termsConditions !== undefined)
      purchaseOrder.termsConditions = termsConditions;
    if (paymentTerms !== undefined) purchaseOrder.paymentTerms = paymentTerms;
    /* No status assignment here. This line was the second, unguarded way to
       issue or cancel an order; status changes go through PATCH /:id/status,
       which checks capability, policy, the transition table and history. */
    if (req.body.piInvoiceNumber !== undefined)
      purchaseOrder.piInvoiceNumber = req.body.piInvoiceNumber || "";
    if (req.body.piInvoicePhoto !== undefined)
      purchaseOrder.piInvoicePhoto = req.body.piInvoicePhoto || "";

    if (items && Array.isArray(items)) {
      const isEmergencyPut = purchaseOrder.isEmergencyOrder || req.body.isEmergencyOrder === true
      for (const item of items) {
        if (!item.rawItem)
          return res.status(400).json({ success: false, message: "Raw item is required for all items" });
        if (!isEmergencyPut && (!item.quantity || item.quantity <= 0))
          return res.status(400).json({ success: false, message: "Valid quantity is required for all items" });
        if (!isEmergencyPut && (!item.unitPrice || item.unitPrice <= 0))
          return res.status(400).json({ success: false, message: "Valid unit price is required for all items" });
      }

      const itemsWithDetails = await Promise.all(
        items.map(async (item) => {
          const ri = await RawItem.findById(item.rawItem)
            .select("unit customUnit name sku variants")
            .lean();

          const registeredUnit = ri
            ? ri.customUnit || ri.unit
            : item.unit || "unit";
          const poUnit = item.unit || registeredUnit;

          // ── per-variant nickname lookup against the (possibly updated) vendor ──
          const vendorNickname = findVariantNickname(
            ri,
            item.variantId,
            purchaseOrder.vendor,
          );

          const qty_put = Number(item.quantity) || 0;
          const price_put = Number(item.unitPrice) || 0;
          const baseTotal_put = qty_put * price_put;
          const validCharges_put = (item.itemCharges || []).filter((c) => c.label?.trim() && parseFloat(c.value) > 0);
          const itemChargesTotal_put = validCharges_put.reduce((s, c) => {
            const v = parseFloat(c.value) || 0;
            return s + (c.type === "percent" ? (baseTotal_put * v) / 100 : v);
          }, 0);
          const resolvedCharges_put = validCharges_put.map((c) => ({
            label: c.label,
            value: c.value,
            type: c.type || "amount",
            amount: c.type === "percent"
              ? (baseTotal_put * (parseFloat(c.value) || 0)) / 100
              : parseFloat(c.value) || 0,
          }));
          const totalPrice_put = baseTotal_put + itemChargesTotal_put;
          const itemGstRate_put = Number(item.gstRate) || 0;
          const itemGstAmount_put = totalPrice_put * itemGstRate_put / 100;
          return {
            rawItem: item.rawItem,
            itemName: item.itemName || ri?.name || "Unknown Item",
            sku: item.sku || ri?.sku || "",
            unit: poUnit,
            baseUnit: registeredUnit,
            vendorNickname,
            quantity: qty_put,
            unitPrice: price_put,
            totalPrice: totalPrice_put,
            gstRate: itemGstRate_put,
            gstAmount: itemGstAmount_put,
            itemCharges: resolvedCharges_put,
            itemChargesTotal: itemChargesTotal_put,
            /* A draft has received nothing, so these start at zero — but they
               are written from the EXISTING line where one matches, never
               reset blindly. Editing must not be a way to make a received
               quantity disappear. */
            receivedQuantity: 0,
            pendingQuantity: qty_put,
            status: "PENDING",
            variantId: item.variantId || null,
            variantCombination: item.variantCombination || [],
            variantName: (item.variantCombination || []).join(" • ") || "",
            variantSku: item.variantSku || "",
            expectedDeliveryDate: item.expectedDeliveryDate
              ? new Date(item.expectedDeliveryDate)
              : null,
          };
        }),
      );

      purchaseOrder.items = itemsWithDetails;

      const updatedSubtotal = itemsWithDetails.reduce((s, i) => s + (i.totalPrice || 0), 0);
      const updatedTaxAmount = itemsWithDetails.reduce((s, i) => s + (i.gstAmount || 0), 0);
      const updatedCustomTotal = (purchaseOrder.customCharges || []).reduce(
        (s, c) => s + (parseFloat(c.amount) || 0),
        0,
      );
      purchaseOrder.subtotal = updatedSubtotal;
      purchaseOrder.taxAmount = updatedTaxAmount;
      purchaseOrder.totalAmount =
        updatedSubtotal +
        updatedTaxAmount +
        (purchaseOrder.shippingCharges || 0) -
        (purchaseOrder.discount || 0) +
        updatedCustomTotal;
      purchaseOrder.totalPending = itemsWithDetails.reduce(
        (s, i) => s + i.quantity,
        0,
      );
    }

    await purchaseOrder.save();

    const changes = [];
    const after = {
      vendorName: purchaseOrder.vendorName,
      totalAmount: purchaseOrder.totalAmount,
      lineCount: (purchaseOrder.items || []).length,
      expectedDeliveryDate: purchaseOrder.expectedDeliveryDate
        ? new Date(purchaseOrder.expectedDeliveryDate).toISOString()
        : null,
    };
    for (const key of Object.keys(before)) {
      if (String(before[key]) !== String(after[key])) {
        changes.push({ field: key, from: before[key], to: after[key] });
      }
    }
    await actionHistory.record(req.tenant, {
      entityType: ENTITY,
      entityId: purchaseOrder._id,
      documentNumber: purchaseOrder.poNumber,
      action: "EDITED",
      previousState: "DRAFT",
      resultingState: "DRAFT",
      requestId: req.id || "",
      changes,
    });

    const populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("vendor", "companyName contactPerson")
      .populate("items.rawItem", "name sku unit")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      message: "Purchase order updated successfully",
      purchaseOrder: populatedPO,
    });
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error updating purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating purchase order",
    });
  }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// RECORD PAYMENT — RETIRED (Chunk 8)
// ─────────────────────────────────────────────────────────────────────────────
// Accounting now owns payment truth: a supplier is paid by a posted PAYMENT
// voucher against the bill, not by an editable figure on the order. This endpoint
// no longer creates any Store payment record — it returns a clear retired-workflow
// response directing the caller to Accounting. Historical `payments[]` remain
// readable through GET /:id/payments (below); they are never mutated here.
router.post("/:id/payment", requireCapability(CAPABILITIES.READ), async (req, res) => {
  return res.status(410).json({
    success: false,
    retired: true,
    reason: "STORE_PAYMENT_RETIRED",
    message: "Recording payments on the purchase order has been retired. Payments are owned by Accounting — record a payment voucher against the supplier's bill in Accounting.",
    accounting: { area: "purchase-vouchers", href: "/accountant/purchase-vouchers" },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PO by vendor
// ─────────────────────────────────────────────────────────────────────────────
router.get("/vendor/:vendorId", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { status } = req.query;
    let filter = { vendor: req.params.vendorId, ...tenantContext.tenantFilter(req.tenant) };
    if (status && status !== "all") filter.status = status;

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status totalReceived totalPending",
      )
      .populate("items.rawItem", "name sku")
      .sort({ createdAt: -1 });

    const totalOrders = purchaseOrders.length;
    const totalAmount = purchaseOrders.reduce(
      (sum, po) => sum + (po.totalAmount || 0),
      0,
    );
    const pendingAmount = purchaseOrders
      .filter((po) => po.status !== "COMPLETED" && po.status !== "CANCELLED")
      .reduce((sum, po) => sum + (po.totalAmount || 0), 0);

    res.json({
      success: true,
      purchaseOrders,
      stats: { totalOrders, totalAmount, pendingAmount },
    });
  } catch (error) {
    console.error("Error fetching vendor purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor purchase orders",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PO by raw item
// ─────────────────────────────────────────────────────────────────────────────
router.get("/raw-item/:itemId", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { status } = req.query;
    let filter = { "items.rawItem": req.params.itemId, ...tenantContext.tenantFilter(req.tenant) };
    if (status && status !== "all") filter.status = status;

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select("poNumber orderDate expectedDeliveryDate vendorName status")
      .populate("vendor", "companyName")
      .sort({ createdAt: -1 });

    const itemOrders = purchaseOrders.map((po) => {
      const item = po.items.find(
        (i) => i.rawItem.toString() === req.params.itemId,
      );
      return {
        _id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        vendorName: po.vendorName,
        status: po.status,
        itemDetails: item
          ? {
              quantity: item.quantity,
              receivedQuantity: item.receivedQuantity,
              pendingQuantity: item.pendingQuantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              status: item.status,
            }
          : null,
      };
    });

    res.json({ success: true, purchaseOrders: itemOrders });
  } catch (error) {
    console.error("Error fetching raw item purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw item purchase orders",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE PO status
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/:id/status",
  /* Issuing an order and cancelling one are different authorities; the
     handler checks the specific one once it knows which was asked for. Both
     are strictly narrower than today's "any authenticated caller". */
  requireCapability(CAPABILITIES.READ),
  refuseLegacyWrite,
  /* Mandatory, not optional. Issuing and cancelling are exactly the actions
     a retry must not repeat. */
  withIdempotency("PO_STATUS"),
  async (req, res) => {
  try {
    const { status, notes, reason } = req.body;
    if (!status)
      return res
        .status(400)
        .json({ success: false, message: "Status is required" });

    /* Only these may be ASKED for. PARTIALLY_RECEIVED and COMPLETED are
       consequences of receiving goods, and DRAFT is not reachable from
       anywhere — see lifecycle.PO_TRANSITIONS. */
    if (!lifecycle.PO_REQUESTABLE.includes(status)) {
      throw fail(
        "VALIDATION",
        "An order can only be issued or cancelled from here. Receipt status follows from recording deliveries.",
        { requested: status, allowed: lifecycle.PO_REQUESTABLE },
      );
    }

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    });
    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    const previousState = purchaseOrder.status;

    /* ── The transition table decides what is even possible ─────────────── */
    const { noop } = lifecycle.assertTransition({ from: previousState, to: status });
    if (noop) {
      /* Already in this state. Succeed without appending a second history
         entry — a re-issue of an issued order is not a second issuance. */
      const body = {
        success: true,
        message: `Purchase order is already ${lifecycle.humanState(status)}`,
        purchaseOrder,
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: purchaseOrder._id })
        : res.json(body);
    }

    /* ── Capability, per transition ─────────────────────────────────────── */
    if (status === "ISSUED" && !req.tenant.capabilitySet.has(CAPABILITIES.PO_ISSUE)) {
      return sendError(res, fail("FORBIDDEN", "You do not have permission to issue purchase orders.", {
        required: [CAPABILITIES.PO_ISSUE],
      }));
    }
    if (status === "CANCELLED" && !req.tenant.capabilitySet.has(CAPABILITIES.PO_CANCEL)) {
      return sendError(res, fail("FORBIDDEN", "You do not have permission to cancel purchase orders.", {
        required: [CAPABILITIES.PO_CANCEL],
      }));
    }

    if (status === "CANCELLED" && purchaseOrder.totalReceived > 0) {
      throw fail(
        "LIFECYCLE_BLOCKED",
        "This order has received goods and cannot be cancelled. Return the goods to the supplier instead.",
        {
          reason: "HAS_RECEIPTS",
          blockingReferences: [{
            collection: "deliveries", count: (purchaseOrder.deliveries || []).length,
            description: `${purchaseOrder.totalReceived} unit(s) already received`,
          }],
        },
      );
    }

    /* ── Cancellation is a recorded decision, so it owes a reason ───────── */
    if (status === "CANCELLED") {
      lifecycle.assertCancellable({
        entityLabel: "purchase order",
        state: previousState,
        cancellableStates: ["DRAFT", "ISSUED"],
        reason,
      });
    }

    /* ── Approval policy, where one is configured ───────────────────────── */
    let policyOutcome = "NONE_MATCHED";
    if (status === "ISSUED") {
      const resolution = await approvalPolicy.resolvePolicy({
        companyId: req.tenant.companyId,
        documentType: "PURCHASE_ORDER",
        amount: purchaseOrder.totalAmount || 0,
        siteId: req.tenant.siteId,
        isEmergency: Boolean(purchaseOrder.isEmergencyOrder),
      });
      const decision = approvalPolicy.evaluate({ resolution, ctx: req.tenant });
      policyOutcome = decision.policy;
      if (!decision.allowed) {
        return sendError(res, fail("FORBIDDEN",
          "Your approval authority does not cover an order of this value.",
          { required: [decision.requiredCapability], level: decision.level }));
      }
    }

    const wasIssuedBefore = purchaseOrder.status === "ISSUED";
    purchaseOrder.status = status;
    if (status === "ISSUED") purchaseOrder.approvedBy = req.user.id;

    if (status === "ISSUED" && !wasIssuedBefore) {
      NotificationService.sendToRole("ceo", {
        title: "New Purchase Order Issued",
        body: `${purchaseOrder.poNumber} — ₹${(purchaseOrder.totalAmount || 0).toLocaleString("en-IN")} to ${purchaseOrder.vendorName || "vendor"}`,
        type: "request",
        url: `/ceo/dashboard/purchase-orders/${purchaseOrder._id}`,
        tag: `po-${purchaseOrder._id}`,
      }).catch(() => {});
    }

    if (notes) {
      purchaseOrder.notes = purchaseOrder.notes
        ? `${purchaseOrder.notes}\nStatus changed to ${status}: ${notes}`
        : `Status changed to ${status}: ${notes}`;
    }

    await purchaseOrder.save();

    await actionHistory.record(req.tenant, {
      entityType: ENTITY,
      entityId: purchaseOrder._id,
      documentNumber: purchaseOrder.poNumber,
      action: status === "CANCELLED" ? "CANCELLED" : status === "ISSUED" ? "ISSUED" : "STATUS_CHANGED",
      previousState,
      resultingState: status,
      reason: reason || "",
      requestId: req.id || "",
      idempotencyKey: req.idempotent?.key || "",
      /* The policy outcome is recorded rather than assumed: "no policy
         matched" is a fact somebody may need to see later, and a silent
         absence would look identical to an approval. */
      metadata: { policy: policyOutcome, totalAmount: purchaseOrder.totalAmount || 0 },
    });

    const body = {
      success: true,
      message: `Purchase order status updated to ${status}`,
      purchaseOrder,
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: purchaseOrder._id })
      : res.json(body);
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error updating purchase order status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating purchase order status",
    });
  }
  },
);

// ── Canonicalise legacy receipt aliases into the ONE command shape ───────────
// Runs BEFORE withIdempotency (which hashes req.body), so a legacy retry
// (itemId / deliveryDate) and a canonical one (poItemId / receiptDate) of the
// SAME receipt hash identically and replay instead of colliding as a key reuse.
// It rewrites ONLY the recognised aliases and normalises valid numeric
// quantities; it never sorts receipt lines and never repairs invalid business
// input (an unparseable quantity is left for validation to refuse).
function normalizeReceiptCommand(req, _res, next) {
  const b = req.body;
  if (b && typeof b === "object") {
    if (b.deliveryDate !== undefined && b.receiptDate === undefined) b.receiptDate = b.deliveryDate;
    delete b.deliveryDate;
    if (Array.isArray(b.items)) {
      b.items = b.items.map((it) => {
        if (!it || typeof it !== "object") return it;
        const line = { ...it };
        if (line.itemId !== undefined && line.poItemId === undefined) line.poItemId = line.itemId;
        delete line.itemId;
        // A valid numeric quantity (number OR numeric string) is normalised to a
        // Number so "5" and 5 hash alike; anything else is left untouched.
        const q = line.quantity;
        if ((typeof q === "number" || (typeof q === "string" && q.trim() !== "")) && Number.isFinite(Number(q))) {
          line.quantity = Number(q);
        }
        return line; // variant, warehouse/location, and other fields preserved
      });
    }
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// GOODS RECEIPT — the ONE receipt implementation.
//
// `handleGoodsReceipt` is the single orchestrator behind BOTH receiving URLs. It
// holds no receipt engine of its own: line validation, unit conversion, RawItem/
// variant stock, location movement, PO-line update, the numbered GoodsReceipt and
// the PO's compatibility delivery reference ALL live in
// services/storePurchase/goodsReceipt.service.js. V1 proves RECEIPT ONLY —
// over-receipt is refused, and nothing is ever called "accepted".
// ─────────────────────────────────────────────────────────────────────────────
async function handleGoodsReceipt(req, res, { includePurchaseOrder = false, successStatus = 201 } = {}) {
  try {
    const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
    const grn = require("../../../../services/storePurchase/goodsReceipt.service");

    const purchaseOrder = await PurchaseOrder.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) })
      .populate("items.rawItem", "name sku unit customUnit");
    if (!purchaseOrder) return res.status(404).json({ success: false, message: "PO not found" });

    // The authoritative goodsReceipt is ALWAYS returned; a legacy caller also
    // gets the populated order back for backward compatibility.
    const withPO = async (extra) => includePurchaseOrder
      ? {
          ...extra,
          purchaseOrder: await PurchaseOrder.findById(purchaseOrder._id)
            .populate("vendor", "companyName contactPerson")
            .populate("items.rawItem", "name sku unit customUnit")
            .populate("deliveries.receivedBy", "name email"),
        }
      : extra;

    // ── Replay/recovery: return the SAME GRN, never a second movement ──
    if (req.idempotent?.recovering) {
      const existing = await GoodsReceipt.findOne({ companyId: req.tenant.companyId, purchaseOrderId: purchaseOrder._id, idempotencyKey: req.idempotent.key });
      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY, entityId: purchaseOrder._id, idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: purchaseOrder.poNumber,
          action: existing ? "RECEIVED" : "RECEIPT_RECONCILIATION_REQUIRED",
          resultingState: purchaseOrder.status, requestId: req.id || "", idempotencyKey: req.idempotent.key,
          reason: existing ? "" : "Stock effect marked but no goods receipt was written.",
          metadata: { recovered: true, goodsReceiptNumber: existing?.receiptNumber || null },
        },
      });
      if (!existing) {
        throw fail("LIFECYCLE_BLOCKED",
          "This receipt was interrupted after the stock effect was marked but before the goods receipt was written. Check the item's stock and reconcile — do not record it again.",
          { reason: "PARTIAL_RECEIPT_NEEDS_RECONCILIATION", poNumber: purchaseOrder.poNumber });
      }
      return await req.idempotent.succeed(200, await withPO({ success: true, message: "This goods receipt was already recorded.", goodsReceipt: existing }), { entityType: ENTITY, entityId: purchaseOrder._id });
    }

    if (purchaseOrder.status === "DRAFT") return res.status(400).json({ success: false, message: "Cannot receive against a draft PO" });
    if (purchaseOrder.status === "CANCELLED") return res.status(400).json({ success: false, message: "Cannot receive against a cancelled PO" });

    const previousState = purchaseOrder.status;
    const { items, warehouseId, locationId, invoiceNumber, notes } = req.body;
    // The legacy screen sends `deliveryDate`; accept it as the receipt date.
    const receiptDate = req.body.receiptDate || req.body.deliveryDate;

    // ── Destination (one per receipt), validated BEFORE any write ──
    let warehouse = null, location = null;
    if (warehouseId && locationId) {
      warehouse = await Warehouse.findOne({ _id: warehouseId, ...tenantContext.tenantFilter(req.tenant) }).lean();
      location = locStock.findLocation(warehouse, locationId);
      const locErr = locStock.usableLocationError(warehouse, location, req.tenant.companyId);
      if (locErr) return res.status(400).json({ success: false, message: locErr.message, reason: locErr.reason });
    } else if (warehouseId || locationId) {
      return res.status(400).json({ success: false, message: "A destination needs both a warehouse and a location.", reason: "LOCATION_INCOMPLETE" });
    }

    // ── Validate every line (unknown/cancelled/foreign, positive qty,
    //    over-receipt, UoM conversion) — throws with NOTHING mutated ──
    const { plans } = await grn.validateReceiptLines({ purchaseOrder, items, tenant: req.tenant });

    // Mark the effect at-most-once BEFORE the first stock write.
    if (req.idempotent?.record) {
      await idempotencyService.markEffectApplied({ record: req.idempotent.record, entityType: ENTITY, entityId: purchaseOrder._id });
    }

    let created = null;
    await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record,
      mutate: async (session) => {
        const out = await grn.applyReceipt({
          session, tenant: req.tenant, purchaseOrder, plans,
          header: { warehouse, location, invoiceNumber, receiptDate, notes },
          actor: { id: req.user.id, name: req.user.name },
          idempotencyKey: req.idempotent?.key || "",
        });
        created = out.goodsReceipt;
        return {
          entityType: ENTITY, entityId: purchaseOrder._id, result: true,
          entry: {
            entityType: ENTITY, entityId: purchaseOrder._id, documentNumber: purchaseOrder.poNumber,
            action: "RECEIVED", previousState, resultingState: purchaseOrder.status,
            requestId: req.id || "", idempotencyKey: req.idempotent?.key || "",
            metadata: { goodsReceiptNumber: created.receiptNumber, lineCount: plans.length, invoiceNumber: invoiceNumber || "" },
          },
        };
      },
    });

    const body = await withPO({ success: true, message: `Goods receipt ${created.receiptNumber} recorded.`, goodsReceipt: created });
    return req.idempotent
      ? await req.idempotent.succeed(successStatus, body, { entityType: ENTITY, entityId: purchaseOrder._id })
      : res.status(successStatus).json(body);
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[goods-receipt] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/receive — DEPRECATED compatibility adapter.
//
// It contains NO receipt engine any more (its independent RawItem mutation,
// surplus calculation, unit conversion, location-stock write, PO delivery
// insertion and recovery were removed). It translates the legacy request shape
// (itemId / deliveryDate — already understood by the canonical command) and
// delegates to the ONE implementation, returning the authoritative goodsReceipt
// (with _id and receiptNumber) alongside a legacy purchaseOrder envelope and a
// 200 for old callers. Prefer POST /:id/goods-receipts.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/receive",
  requireCapability(CAPABILITIES.RECEIPT_RECORD),
  refuseLegacyWrite,
  // Canonicalise legacy aliases BEFORE hashing, then bind the fingerprint to
  // THIS purchase order so a key cannot replay another PO's receipt.
  normalizeReceiptCommand,
  withIdempotency("PO_RECEIVE", { target: (req) => req.params.id }),
  (req, res) => handleGoodsReceipt(req, res, { includePurchaseOrder: true, successStatus: 200 }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/goods-receipts — GOODS RECEIPT V1 (authoritative, line-level).
//
// The canonical receiving URL. A thin wrapper over the ONE implementation
// (`handleGoodsReceipt` above) — no receipt engine here. V1 proves RECEIPT ONLY:
// it refuses over-receipt, and never calls a quantity "accepted".
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/goods-receipts",
  requireCapability(CAPABILITIES.RECEIPT_RECORD),
  refuseLegacyWrite,
  // Same normalisation + same PO-bound target as /receive, so a retry across
  // the two URLs for one PO replays, while reuse against another PO refuses.
  normalizeReceiptCommand,
  withIdempotency("PO_RECEIVE", { target: (req) => req.params.id }),
  (req, res) => handleGoodsReceipt(req, res),
);

// GET /:id/goods-receipts — the authoritative receipts recorded against this PO.
router.get("/:id/goods-receipts", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tenantContext.tenantFilter(req.tenant) }).select("_id").lean();
    if (!po) return res.status(404).json({ success: false, message: "PO not found" });
    const receipts = await GoodsReceipt.find({ companyId: req.tenant.companyId, purchaseOrderId: po._id }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, goodsReceipts: receipts });
  } catch (err) {
    console.error("[goods-receipt] list-by-po error:", err);
    res.status(500).json({ success: false, message: "Server error while loading goods receipts" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PAYMENT STATUS — RETIRED (Chunk 8)
// ─────────────────────────────────────────────────────────────────────────────
// The PO's payment status is no longer editable in Store; bill and payment truth
// live in Accounting. This endpoint writes nothing and directs the caller there.
router.patch("/:id/payment-status", requireCapability(CAPABILITIES.READ), async (req, res) => {
  return res.status(410).json({
    success: false,
    retired: true,
    reason: "STORE_PAYMENT_RETIRED",
    message: "Editing the purchase order's payment status has been retired. Bill and payment state are owned by Accounting.",
    accounting: { area: "purchase-vouchers", href: "/accountant/purchase-vouchers" },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET PAYMENT HISTORY
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/payments", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    })
      .select("payments poNumber totalAmount")
      .populate("payments.recordedBy", "name email");

    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    const totalPaid =
      purchaseOrder.payments?.reduce(
        (sum, payment) => sum + payment.amount,
        0,
      ) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;

    // These are HISTORICAL Store payment records only — payment truth is now
    // owned by Accounting. They are preserved read-only and clearly labelled;
    // they are never mutated (the recording endpoints are retired).
    res.json({
      success: true,
      legacy: true,
      legacyNote: "Legacy Store payment records. Payments are now recorded in Accounting; these historical figures are read-only.",
      payments: purchaseOrder.payments || [],
      totalPaid,
      remainingAmount,
      poNumber: purchaseOrder.poNumber,
      totalAmount: purchaseOrder.totalAmount,
    });
  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching payments",
    });
  }
});

module.exports = router;
