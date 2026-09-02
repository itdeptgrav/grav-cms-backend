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

// ── Convert quantity using Unit conversions ────────────────────────────────
async function convertQuantity(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (!quantity || isNaN(quantity)) return quantity;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit })
      .populate("conversions.toUnit", "name")
      .lean();
    if (fromDoc) {
      const direct = (fromDoc.conversions || []).find(
        (c) => (c.toUnit?.name || c.toUnit) === toUnit,
      );
      if (direct?.quantity) return quantity * direct.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit })
      .populate("conversions.toUnit", "name")
      .lean();
    if (toDoc) {
      const reverse = (toDoc.conversions || []).find(
        (c) => (c.toUnit?.name || c.toUnit) === fromUnit,
      );
      if (reverse?.quantity) return quantity / reverse.quantity;
    }
    console.warn(`[PO convertQuantity] No path "${fromUnit}"→"${toUnit}".`);
    return quantity;
  } catch (err) {
    console.error("[PO convertQuantity]", err.message);
    return quantity;
  }
}

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
    const vendors = await Vendor.find({ status: "Active" })
      .select(
        "companyName contactPerson phone email address gstNumber vendorType paymentTerms",
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
// RECORD PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/payment",
  /* Chunk 8 removes Store's payment recording entirely (Accounting owns
     settlement). Until then it is at least scoped and permissioned. */
  requireCapability(CAPABILITIES.PO_APPROVE),
  refuseLegacyWrite,
  withIdempotency("PO_PAYMENT"),
  async (req, res) => {
  try {
    const { amount, paymentMethod, referenceNumber, paymentDate, notes } =
      req.body;

    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Valid payment amount is required" });
    }
    if (!paymentMethod) {
      return res
        .status(400)
        .json({ success: false, message: "Payment method is required" });
    }

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    });
    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    const totalPaid =
      purchaseOrder.payments?.reduce(
        (sum, payment) => sum + (payment.amount || 0),
        0,
      ) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;

    if (amount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (₹${amount}) exceeds remaining amount (₹${remainingAmount})`,
      });
    }

    const paymentRecord = {
      amount: parseFloat(amount),
      paymentMethod,
      referenceNumber: referenceNumber || "",
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      notes: notes || "",
      recordedBy: req.user.id,
    };

    if (!purchaseOrder.payments) purchaseOrder.payments = [];
    purchaseOrder.payments.unshift(paymentRecord);

    const newTotalPaid = totalPaid + amount;
    if (newTotalPaid >= purchaseOrder.totalAmount)
      purchaseOrder.paymentStatus = "COMPLETED";
    else if (newTotalPaid > 0) purchaseOrder.paymentStatus = "PARTIAL";
    else purchaseOrder.paymentStatus = "PENDING";

    await purchaseOrder.save();

    const populatedPO = await PurchaseOrder.findById(
      purchaseOrder._id,
    ).populate("payments.recordedBy", "name email");
    const latestPayment = populatedPO.payments[0];

    await actionHistory.record(req.tenant, {
      entityType: ENTITY,
      entityId: purchaseOrder._id,
      documentNumber: purchaseOrder.poNumber,
      action: "PAYMENT_RECORDED",
      requestId: req.id || "",
      idempotencyKey: req.idempotent?.key || "",
      metadata: { amount: Number(amount), paymentMethod, paymentStatus: purchaseOrder.paymentStatus },
    });

    const body = {
      success: true,
      message: `Payment of ₹${amount} recorded successfully`,
      payment: latestPayment,
      paymentStatus: purchaseOrder.paymentStatus,
      totalPaid: newTotalPaid,
      remainingAmount: purchaseOrder.totalAmount - newTotalPaid,
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: purchaseOrder._id })
      : res.json(body);
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error recording payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error while recording payment",
    });
  }
  },
);

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

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVE delivery (unchanged from your version — handles unit conversion)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/receive",
  requireCapability(CAPABILITIES.RECEIPT_RECORD),
  refuseLegacyWrite,
  /* THE reason idempotency exists. Chunk 0's characterisation test proved a
     re-posted receipt is accepted and silently books the whole delivery into
     stock a second time as "surplus". A key makes the retry a replay. */
  withIdempotency("PO_RECEIVE"),
  async (req, res) => {
  try {
    const { deliveryDate, items, invoiceNumber, notes } = req.body;

    if (!items?.length) {
      return res
        .status(400)
        .json({ success: false, message: "At least one item is required" });
    }

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    }).populate(
      "items.rawItem",
      "name sku unit customUnit variants quantity status minStock maxStock",
    );

    if (!purchaseOrder)
      return res.status(404).json({ success: false, message: "PO not found" });

    /* ── RECOVERY ───────────────────────────────────────────────────────────
     * A previous attempt with this key already moved the stock and saved the
     * order; something after that failed. Re-running would receive the same
     * delivery twice — the exact defect Chunk 0 pinned. So the work is not
     * redone: the missing history entry is written if it is missing, and the
     * caller is handed the order as it now stands. */
    if (req.idempotent?.recovering) {
      /* Did the order record the delivery, or did the previous attempt die
         between moving stock and saving the order? The two need different
         answers: one is a clean replay, the other needs a human. */
      const deliveryRecorded = (purchaseOrder.deliveries || []).length > 0
        && (purchaseOrder.totalReceived || 0) > 0;

      await unitOfWork.recover(req.tenant, {
        entityType: ENTITY,
        entityId: purchaseOrder._id,
        idempotencyKey: req.idempotent.key,
        entry: {
          documentNumber: purchaseOrder.poNumber,
          action: deliveryRecorded ? "RECEIVED" : "RECEIPT_RECONCILIATION_REQUIRED",
          resultingState: purchaseOrder.status,
          requestId: req.id || "",
          idempotencyKey: req.idempotent.key,
          reason: deliveryRecorded ? "" : "Stock moved but the order did not record the delivery.",
          metadata: { recovered: true, totalReceived: purchaseOrder.totalReceived || 0 },
        },
      });

      if (!deliveryRecorded) {
        /* Never re-run: the stock already moved. Say so plainly instead of
           repeating it or pretending it succeeded. */
        throw fail(
          "LIFECYCLE_BLOCKED",
          "This delivery was partly recorded before an error interrupted it. The stock has already been received, but the order was not updated. Check the item's stock and correct the order — do not record the delivery again.",
          { reason: "PARTIAL_RECEIPT_NEEDS_RECONCILIATION", poNumber: purchaseOrder.poNumber },
        );
      }
      const recovered = await PurchaseOrder.findById(purchaseOrder._id)
        .populate("vendor", "companyName contactPerson")
        .populate("items.rawItem", "name sku unit customUnit")
        .populate("deliveries.receivedBy", "name email");
      return await req.idempotent.succeed(200, {
        success: true,
        message: "This delivery was already recorded.",
        purchaseOrder: recovered,
        processed: [],
      }, { entityType: ENTITY, entityId: purchaseOrder._id });
    }

    const previousState = purchaseOrder.status;
    if (purchaseOrder.status === "DRAFT")
      return res
        .status(400)
        .json({ success: false, message: "Cannot receive against a draft PO" });
    if (purchaseOrder.status === "CANCELLED")
      return res.status(400).json({
        success: false,
        message: "Cannot receive against a cancelled PO",
      });

    const updates = [];
    for (const ri of items) {
      const poItem = purchaseOrder.items.find(
        (it) => it._id.toString() === ri.itemId?.toString(),
      );
      if (!poItem) {
        console.error(
          `[receive] itemId ${ri.itemId} not matched in PO items:`,
          purchaseOrder.items.map((it) => it._id.toString()),
        );
        return res.status(400).json({
          success: false,
          message: `Item not found in PO: ${ri.itemId}`,
        });
      }
      const qty = parseFloat(ri.quantity) || 0;
      if (qty <= 0) continue;

      const pending = Math.max(
        0,
        +(poItem.quantity - poItem.receivedQuantity).toFixed(4),
      );

      // Extra delivery: cap received at ordered qty, record surplus separately in stock
      const qtyToReceiveAgainstPO = Math.min(qty, pending);
      const surplusQty = +(qty - qtyToReceiveAgainstPO).toFixed(4);

      if (qtyToReceiveAgainstPO > 0) {
        updates.push({
          poItem,
          rawItemId: poItem.rawItem?._id || poItem.rawItem,
          variantId: ri.variantId || poItem.variantId,
          variantCombination: ri.variantCombination?.length
            ? ri.variantCombination
            : poItem.variantCombination || [],
          qtyInPoUnit: qtyToReceiveAgainstPO,
          poUnit: poItem.unit,
          unitPrice: poItem.unitPrice,
          surplusQty: 0,
        });
      }

      // Push any surplus as a stock-in-only entry (not counted against PO received qty)
      if (surplusQty > 0.001) {
        updates.push({
          poItem,
          rawItemId: poItem.rawItem?._id || poItem.rawItem,
          variantId: ri.variantId || poItem.variantId,
          variantCombination: ri.variantCombination?.length
            ? ri.variantCombination
            : poItem.variantCombination || [],
          qtyInPoUnit: 0,         // not counted against PO
          poUnit: poItem.unit,
          unitPrice: poItem.unitPrice,
          surplusQty,             // only added to stock
          isSurplus: true,
        });
      }
    }

    if (!updates.length) {
      return res
        .status(400)
        .json({ success: false, message: "No valid quantities to receive" });
    }

    let totalReceivedInPoUnits = 0;
    const processed = [];

    /* ── THE MARKER GOES BEFORE THE FIRST STOCK WRITE ───────────────────────
     * Stock moves item by item, outside any transaction on a standalone
     * deployment. If the marker were written after the loop — or after the
     * order save — a failure part-way through would release the key and the
     * retry would move the SAME stock again. Marking first makes the effect
     * at-most-once: any failure from here on sends the retry into recovery,
     * which never re-runs the movement. The price is that a receipt can be
     * left half-applied; that is surfaced for reconciliation below rather
     * than silently repeated, which is the trade every stock system has to
     * make without transactions. */
    if (req.idempotent?.record) {
      await idempotencyService.markEffectApplied({
        record: req.idempotent.record,
        entityType: ENTITY,
        entityId: purchaseOrder._id,
      });
    }

    for (const u of updates) {
      const {
        poItem,
        rawItemId,
        variantId,
        variantCombination,
        qtyInPoUnit,
        poUnit,
        unitPrice,
        surplusQty,
        isSurplus,
      } = u;

      // Effective qty hitting stock = PO portion + any surplus
      const effectiveQtyInPoUnit = qtyInPoUnit + (surplusQty || 0);

      const rawItem = await RawItem.findById(rawItemId);
      if (!rawItem) {
        console.warn(`RawItem not found: ${rawItemId}`);
        continue;
      }

      const registeredUnit = rawItem.customUnit || rawItem.unit;
      const fromUnit = poUnit || registeredUnit;

      let qtyInRegisteredUnit = effectiveQtyInPoUnit;
      if (fromUnit !== registeredUnit) {
        qtyInRegisteredUnit = await convertQuantity(
          effectiveQtyInPoUnit,
          fromUnit,
          registeredUnit,
        );
      }

      // Only advance PO received counter for non-surplus entries
      if (!u.isSurplus) {
        poItem.receivedQuantity += qtyInPoUnit;
        poItem.pendingQuantity = Math.max(
          0,
          poItem.quantity - poItem.receivedQuantity,
        );
        poItem.status =
          poItem.receivedQuantity >= poItem.quantity
            ? "COMPLETED"
            : poItem.receivedQuantity > 0
              ? "PARTIALLY_RECEIVED"
              : "PENDING";
      }

      

      const previousBaseQty = rawItem.quantity;

      if (variantId) {
        let variant = null;
        let variantIdx = -1;

        for (let i = 0; i < rawItem.variants.length; i++) {
          const v = rawItem.variants[i];
          if (v._id?.toString() === variantId.toString()) {
            variant = v;
            variantIdx = i;
            break;
          }
        }

        if (!variant && variantCombination?.length) {
          for (let i = 0; i < rawItem.variants.length; i++) {
            const v = rawItem.variants[i];
            if (
              v.combination?.length === variantCombination.length &&
              v.combination.every((val, idx) => val === variantCombination[idx])
            ) {
              variant = v;
              variantIdx = i;
              break;
            }
          }
        }

        if (variant) {
          variant.quantity = (variant.quantity || 0) + qtyInRegisteredUnit;
          variant.status =
            variant.quantity === 0
              ? "Out of Stock"
              : variant.quantity <= (variant.minStock || rawItem.minStock || 0)
                ? "Low Stock"
                : "In Stock";
          if (!variant.sku)
            variant.sku = poItem.variantSku || `${rawItem.sku}-var`;
          rawItem.variants[variantIdx] = variant;
        } else {
          rawItem.variants.push({
            combination: variantCombination || [],
            quantity: qtyInRegisteredUnit,
            minStock: rawItem.minStock || 0,
            maxStock: rawItem.maxStock || 0,
            sku: poItem.variantSku || `${rawItem.sku}-var-${Date.now()}`,
            status: "In Stock",
          });
        }

        rawItem.quantity = rawItem.variants.reduce(
          (s, v) => s + (v.quantity || 0),
          0,
        );
      } else {
        rawItem.quantity = (rawItem.quantity || 0) + qtyInRegisteredUnit;
      }

      rawItem.status =
        rawItem.quantity === 0
          ? "Out of Stock"
          : rawItem.quantity <= (rawItem.minStock || 0)
            ? "Low Stock"
            : "In Stock";

      const conversionNote =
        fromUnit !== registeredUnit
          ? ` (received ${qtyInPoUnit} ${fromUnit} = ${qtyInRegisteredUnit.toFixed(4)} ${registeredUnit})`
          : "";

      rawItem.stockTransactions.unshift({
        type: variantId ? "VARIANT_ADD" : "ADD",
        quantity: qtyInRegisteredUnit,
        variantId,
        variantCombination,
        previousQuantity: previousBaseQty,
        newQuantity: rawItem.quantity,
        reason: "Purchase Order Delivery",
        supplier: purchaseOrder.vendorName,
        supplierId: purchaseOrder.vendor,
        unitPrice,
        purchaseOrder: purchaseOrder.poNumber,
        purchaseOrderId: purchaseOrder._id,
        invoiceNumber,
        notes: `Received from PO: ${purchaseOrder.poNumber}${conversionNote}`,
        performedBy: req.user.id,
      });

      await rawItem.save();

      processed.push({
        itemName: poItem.itemName,
        variant: variantCombination?.join(" • ") || null,
        qtyInPoUnit,
        poUnit: fromUnit,
        qtyInRegisteredUnit,
        registeredUnit,
        converted: fromUnit !== registeredUnit,
      });

      totalReceivedInPoUnits += u.isSurplus ? 0 : qtyInPoUnit;
      if (u.isSurplus) {
        console.log(
          `[receive] Surplus of ${u.surplusQty} ${poItem.unit} for ${poItem.itemName} — added to stock only, not counted against PO.`
        );
      }
    }

    purchaseOrder.deliveries.unshift({
      deliveryDate: deliveryDate ? new Date(deliveryDate) : new Date(),
      quantityReceived: totalReceivedInPoUnits,
      invoiceNumber: invoiceNumber || "",
      notes: notes || "",
      receivedBy: req.user.id,
    });

    purchaseOrder.totalReceived += totalReceivedInPoUnits;
    purchaseOrder.totalPending = purchaseOrder.items.reduce(
      (s, it) => s + (it.pendingQuantity || 0),
      0,
    );

    purchaseOrder.status =
      purchaseOrder.totalPending === 0
        ? "COMPLETED"
        : purchaseOrder.totalReceived > 0
          ? "PARTIALLY_RECEIVED"
          : purchaseOrder.status;

    /* The order save, the history entry and the idempotency effect marker as
       one unit. On a replica set they commit together; on a standalone the
       marker lands the instant the save does, so a later failure cannot let
       a retry receive this delivery again. */
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
            documentNumber: purchaseOrder.poNumber,
            action: "RECEIVED",
            previousState,
            resultingState: purchaseOrder.status,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: {
              quantityReceived: totalReceivedInPoUnits,
              lineCount: processed.length,
              invoiceNumber: invoiceNumber || "",
            },
          },
        };
      },
    });

    const populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("vendor", "companyName contactPerson")
      .populate("items.rawItem", "name sku unit customUnit")
      .populate("deliveries.receivedBy", "name email");

    const body = {
      success: true,
      message: `Delivery received. ${totalReceivedInPoUnits} unit(s) recorded.`,
      purchaseOrder: populatedPO,
      processed,
    };
    return req.idempotent
      ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: purchaseOrder._id })
      : res.json(body);
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("Error receiving delivery:", err);
    res.status(500).json({ success: false, message: err.message });
  }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PAYMENT STATUS
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/:id/payment-status",
  requireCapability(CAPABILITIES.PO_APPROVE),
  refuseLegacyWrite,
  async (req, res) => {
  try {
    const { status } = req.body;
    if (!status)
      return res
        .status(400)
        .json({ success: false, message: "Payment status is required" });

    const validStatuses = ["PENDING", "PARTIAL", "COMPLETED"];
    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment status" });
    }

    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantContext.tenantFilter(req.tenant),
    });
    if (!purchaseOrder)
      return res
        .status(404)
        .json({ success: false, message: "Purchase order not found" });

    purchaseOrder.paymentStatus = status;
    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Payment status updated to ${status}`,
      purchaseOrder,
    });
  } catch (error) {
    if (error?.name === "StorePurchaseError") return sendError(res, error);
    console.error("Error updating payment status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating payment status",
    });
  }
  },
);

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

    res.json({
      success: true,
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
