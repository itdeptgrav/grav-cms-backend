// routes/Cms_routes/HistoryReport/vendor.js  — COMPLETE FILE
// Mount in app.js as:
//   app.use("/api/ceo/inventory/vendors", require("./routes/Cms_routes/HistoryReport/vendor"));

const express = require("express");
const router  = express.Router();
const Vendor  = require("../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const PurchaseOrder = require("../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// ─── IMPORTANT: named/static routes MUST come before /:id dynamic routes ─────

// ── GET /stats ────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const [total, active, inactive, blacklisted, verified] = await Promise.all([
      Vendor.countDocuments(),
      Vendor.countDocuments({ status: "Active" }),
      Vendor.countDocuments({ status: "Inactive" }),
      Vendor.countDocuments({ status: "Blacklisted" }),
      Vendor.countDocuments({ isVerified: true }),
    ]);
    const ratingAgg = await Vendor.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" } } }]);
    const avgRating = ratingAgg[0]?.avg ? Math.round(ratingAgg[0].avg * 10) / 10 : 0;
    const spendAgg  = await PurchaseOrder.aggregate([
      { $match: { status: { $in: ["COMPLETED", "ISSUED", "PARTIALLY_RECEIVED"] } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);
    const totalSpend = spendAgg[0]?.total || 0;
    res.json({ success: true, stats: { total, active, inactive, blacklisted, verified, avgRating, totalSpend } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /paginated ─────────────────────────────────────────────────────────────
// Used by the CEO vendors list page
router.get("/paginated", async (req, res) => {
  try {
    const { search = "", status, type, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { companyName:    { $regex: search, $options: "i" } },
        { contactPerson:  { $regex: search, $options: "i" } },
        { email:          { $regex: search, $options: "i" } },
        { phone:          { $regex: search, $options: "i" } },
        { "address.city": { $regex: search, $options: "i" } },
      ];
    }
    if (status && status !== "all") filter.status     = status;
    if (type   && type   !== "all") filter.vendorType  = type;

    const skip   = (parseInt(page) - 1) * parseInt(limit);
    const total  = await Vendor.countDocuments(filter);
    const vendors = await Vendor.find(filter)
      .select("-verificationSignature")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const types = await Vendor.distinct("vendorType");
    res.json({
      success: true,
      vendors,
      types: types.filter(Boolean),
      pagination: {
        page:       parseInt(page),
        limit:      parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /types ─────────────────────────────────────────────────────────────────
router.get("/types", async (req, res) => {
  res.json({ success: true, types: [
    "Raw Material Supplier","Fabric Supplier","Accessories Supplier",
    "Packaging Supplier","Equipment Supplier","Logistics","Other"
  ]});
});

// ── GET /common-products ───────────────────────────────────────────────────────
router.get("/common-products", async (req, res) => {
  res.json({ success: true, products: [
    "Cotton Fabric","Polyester Fabric","Silk Fabric","Denim Fabric","Linen Fabric",
    "Zippers","Buttons","Threads","Labels","Tags","Packaging Boxes","Polybags",
    "Hangers","Sewing Machines","Cutting Machines","Embroidery Machines",
    "Fusing Machines","Ironing Equipment","Transport Services","Warehousing"
  ]});
});

// ── GET / (simple list — kept for backward compat) ────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { search = "", status, vendorType } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { companyName:   { $regex: search, $options: "i" } },
        { contactPerson: { $regex: search, $options: "i" } },
        { email:         { $regex: search, $options: "i" } },
        { phone:         { $regex: search, $options: "i" } },
      ];
    }
    if (status)     filter.status     = status;
    if (vendorType) filter.vendorType = vendorType;

    const vendors = await Vendor.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedBy",  "name email")
      .sort({ createdAt: -1 });

    const [total, active] = await Promise.all([
      Vendor.countDocuments(),
      Vendor.countDocuments({ status: "Active" }),
    ]);

    res.json({ success: true, vendors, stats: { total, active },
      filters: { types: ["Raw Material Supplier","Fabric Supplier","Accessories Supplier","Packaging Supplier","Equipment Supplier","Logistics","Other"],
        statuses: ["Active","Inactive","Blacklisted"] } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      companyName, vendorType, contactPerson, email, phone, alternatePhone,
      address, gstNumber, panNumber, primaryProducts, bankDetails, notes, status, rating,
    } = req.body;

    if (!companyName?.trim())
      return res.status(400).json({ success: false, message: "Company name is required" });

    if (gstNumber?.trim()) {
      const existing = await Vendor.findOne({ gstNumber: gstNumber.trim().toUpperCase() });
      if (existing)
        return res.status(400).json({ success: false, message: "Vendor with this GST number already exists" });
    }

    const newVendor = new Vendor({
      companyName:    companyName.trim(),
      vendorType:     vendorType || "Raw Material Supplier",
      contactPerson:  contactPerson?.trim() || "",
      email:          email?.trim().toLowerCase() || "",
      phone:          phone?.trim() || "",
      alternatePhone: alternatePhone?.trim() || "",
      address: {
        street:  address?.street?.trim()  || "",
        city:    address?.city?.trim()    || "",
        state:   address?.state?.trim()   || "",
        pincode: address?.pincode?.trim() || "",
        country: address?.country?.trim() || "India",
      },
      gstNumber:  gstNumber?.trim().toUpperCase()  || "",
      panNumber:  panNumber?.trim().toUpperCase()   || "",
      primaryProducts: Array.isArray(primaryProducts) ? primaryProducts.map(p => p.trim()).filter(Boolean) : [],
      bankDetails: {
        accountName:   bankDetails?.accountName?.trim()             || "",
        accountNumber: bankDetails?.accountNumber?.trim()           || "",
        bankName:      bankDetails?.bankName?.trim()                || "",
        ifscCode:      bankDetails?.ifscCode?.trim().toUpperCase()  || "",
        branch:        bankDetails?.branch?.trim()                  || "",
      },
      notes:  notes?.trim()  || "",
      status: status || "Active",
      rating: rating || 3,
      createdBy: req.user.id,
    });

    await newVendor.save();
    res.status(201).json({ success: true, message: "Vendor registered successfully", vendor: newVendor });
  } catch (e) {
    if (e.code === 11000)
      return res.status(400).json({ success: false, message: "Vendor with this GST number already exists" });
    res.status(500).json({ success: false, message: e.message });
  }
});


// ── GET /price-compare ───────────────────────────────────────────────────────
// Query: rawItemId (required), variantId (optional)
// Returns per-vendor: alias info + PO history for that item + defect/return metrics
router.get("/price-compare", async (req, res) => {
  try {
    const { rawItemId, variantId } = req.query;
    if (!rawItemId)
      return res.status(400).json({ success: false, message: "rawItemId is required." });

    const raw = await RawItem.findById(rawItemId)
      .select("name sku unit customUnit variants quantity")
      .lean();
    if (!raw) return res.status(404).json({ success: false, message: "Raw item not found." });

    const unit = raw.customUnit || raw.unit || "unit";

    // Collect alias entries
    let aliasEntries = [];
    if (variantId) {
      const variant = (raw.variants || []).find(v => String(v._id) === String(variantId));
      aliasEntries = variant?.vendorNicknames || [];
    } else {
      const seen = new Set();
      for (const variant of (raw.variants || [])) {
        for (const vn of (variant.vendorNicknames || [])) {
          const key = String(vn.vendor);
          if (!vn.vendor || seen.has(key)) continue;
          seen.add(key);
          aliasEntries.push(vn);
        }
      }
    }

    if (!aliasEntries.length) {
      return res.json({ success: true, results: [], itemName: raw.name, itemSku: raw.sku, unit, currentStock: raw.quantity || 0 });
    }

    const results = [];

    for (const alias of aliasEntries) {
      if (!alias.vendor) continue;

      const vendor = await Vendor.findById(alias.vendor)
        .select("companyName isVerified status rating phone email").lean();
      if (!vendor) continue;

      // All POs from this vendor that contain this raw item
      const poQuery = {
        vendor: alias.vendor,
        "items.rawItem": new (require("mongoose").Types.ObjectId)(rawItemId),
      };
      const pos = await PurchaseOrder.find(poQuery)
        .select("poNumber orderDate expectedDeliveryDate totalAmount status items deliveries returnRequests payments")
        .sort({ orderDate: -1 })
        .lean();

      // Build PO history for this item specifically
      const poHistory = pos.map(po => {
        const poItems = (po.items || []).filter(i => String(i.rawItem) === String(rawItemId));
        const totalOrdered  = poItems.reduce((s, i) => s + (i.quantity || 0), 0);
        const totalReceived = poItems.reduce((s, i) => s + (i.receivedQuantity || 0), 0);
        const avgUnitPrice  = poItems.length > 0
          ? poItems.reduce((s, i) => s + (i.unitPrice || 0), 0) / poItems.length : 0;

        // Return requests for this item in this PO
        const itemReturns = (po.returnRequests || []).filter(rr =>
          String(rr.rawItem) === String(rawItemId)
        );
        const damagedQty = itemReturns.reduce((s, rr) => s + (rr.damagedQuantity || 0), 0);

        return {
          poNumber:            po.poNumber,
          orderDate:           po.orderDate,
          expectedDelivery:    po.expectedDeliveryDate,
          status:              po.status,
          totalAmount:         po.totalAmount,
          orderedQty:          totalOrdered,
          receivedQty:         totalReceived,
          pendingQty:          Math.max(0, totalOrdered - totalReceived),
          unitPrice:           avgUnitPrice,
          fulfilmentPct:       totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0,
          returnCount:         itemReturns.length,
          damagedQty,
          defectRate:          totalReceived > 0 ? Math.round((damagedQty / totalReceived) * 100) : 0,
        };
      });

      // Aggregate metrics
      const completedPOs      = poHistory.filter(p => p.status === "COMPLETED");
      const totalOrderedQty   = poHistory.reduce((s, p) => s + p.orderedQty, 0);
      const totalReceivedQty  = poHistory.reduce((s, p) => s + p.receivedQty, 0);
      const totalDamagedQty   = poHistory.reduce((s, p) => s + p.damagedQty, 0);
      const totalSpend        = completedPOs.reduce((s, p) => s + p.totalAmount, 0);
      const avgUnitPrice      = poHistory.length > 0
        ? poHistory.filter(p => p.unitPrice > 0).reduce((s, p) => s + p.unitPrice, 0) /
          (poHistory.filter(p => p.unitPrice > 0).length || 1)
        : 0;
      const overallDefectRate = totalReceivedQty > 0
        ? Math.round((totalDamagedQty / totalReceivedQty) * 100) : 0;
      const avgFulfilment     = poHistory.length > 0
        ? Math.round(poHistory.reduce((s, p) => s + p.fulfilmentPct, 0) / poHistory.length) : 100;

      results.push({
        vendorId:         String(vendor._id),
        vendorName:       vendor.companyName,
        vendorIsVerified: vendor.isVerified || false,
        vendorStatus:     vendor.status,
        vendorRating:     vendor.rating || 0,
        vendorPhone:      vendor.phone || "",
        vendorEmail:      vendor.email || "",
        // Alias fields
        vendorCode:       alias.nickname || "",
        price:            alias.price || 0,
        unit,
        deliveryDays:     alias.deliveryDays || 0,
        // PO metrics
        totalPOs:         poHistory.length,
        completedPOs:     completedPOs.length,
        totalSpend,
        totalOrderedQty,
        totalReceivedQty,
        totalDamagedQty,
        avgFulfilment,
        overallDefectRate,
        avgUnitPrice:     Math.round(avgUnitPrice * 100) / 100,
        lastOrderDate:    poHistory[0]?.orderDate || null,
        lastUnitPrice:    poHistory[0]?.unitPrice || alias.price || 0,
        // Full PO history
        poHistory,
      });
    }

    results.sort((a, b) => (a.price || 9e9) - (b.price || 9e9));
    res.json({ success: true, results, itemName: raw.name, itemSku: raw.sku, unit, currentStock: raw.quantity || 0 });
  } catch (e) {
    console.error("[price-compare]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── Dynamic /:id routes below ────────────────────────────────────────────────

// ── GET /:id/detail — full enriched view for CEO modal / detail page ──────────
router.get("/:id/detail", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id)
      .populate("createdBy",  "name email")
      .populate("updatedBy",  "name email")
      .populate("verifiedBy", "name email")
      .lean();
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });

    // All POs for this vendor — select every field needed by the view page
    const pos = await PurchaseOrder.find({ vendor: req.params.id })
      .select([
        "poNumber", "orderDate", "expectedDeliveryDate", "totalAmount",
        "subtotal", "taxRate", "taxAmount", "shippingCharges", "discount",
        "status", "paymentStatus", "paymentTerms", "notes", "termsConditions",
        "items", "deliveries", "returnRequests", "payments",
        "totalReceived", "totalPending", "createdBy", "approvedBy",
      ].join(" "))
      .populate("items.rawItem",  "name sku unit category")
      .populate("payments.recordedBy", "name email")
      .populate("deliveries.receivedBy", "name")
      .populate("createdBy",  "name email")
      .populate("approvedBy", "name email")
      .sort({ orderDate: -1 })
      .lean();

    // ── Aggregate PO stats ────────────────────────────────────────────────────
    const poStats = {
      totalOrders: pos.length,
      totalSpent: 0,          // all non-cancelled PO amounts (what we've committed to pay)
      totalPaidAmount: 0,     // sum of actual payments made
      totalDueAmount: 0,      // invoiced – paid
      completed: 0,
      issued: 0,
      partialReceived: 0,
      cancelled: 0,
      totalReturns: 0,
      totalDamagedQty: 0,
      pendingAmount: 0,       // amount still in active/open POs
    };

    pos.forEach(po => {
      const amt = po.totalAmount || 0;
      const paid = (po.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
      poStats.totalPaidAmount += paid;

      switch (po.status) {
        case "COMPLETED":          poStats.completed++;       poStats.totalSpent += amt; break;
        case "ISSUED":             poStats.issued++;          poStats.pendingAmount += amt; break;
        case "PARTIALLY_RECEIVED": poStats.partialReceived++; poStats.pendingAmount += amt; break;
        case "CANCELLED":          poStats.cancelled++; break;
        default: /* DRAFT etc */   poStats.pendingAmount += amt;
      }

      (po.returnRequests || []).forEach(rr => {
        poStats.totalReturns++;
        poStats.totalDamagedQty += rr.damagedQuantity || 0;
      });
    });

    // Total invoiced = all POs (excluding cancelled)
    const totalInvoicedAll = pos
      .filter(po => po.status !== "CANCELLED")
      .reduce((s, po) => s + (po.totalAmount || 0), 0);
    poStats.totalDueAmount = Math.max(0, totalInvoicedAll - poStats.totalPaidAmount);
    // totalSpent = completed POs; add partial for "total transacted"
    poStats.totalTransacted = pos
      .filter(po => !["CANCELLED", "DRAFT"].includes(po.status))
      .reduce((s, po) => s + (po.totalAmount || 0), 0);

    // Return rate (POs with any return ÷ completed POs)
    const posWithReturns = pos.filter(p => (p.returnRequests || []).length > 0).length;
    poStats.returnRate = poStats.completed > 0
      ? Math.round((posWithReturns / poStats.completed) * 100) : 0;

    // Fulfilment rate (avg across all non-cancelled POs)
    let fulfilSum = 0; let fulfilCount = 0;
    pos.forEach(po => {
      if (po.status === "CANCELLED") return;
      const ordered  = (po.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
      const received = (po.items || []).reduce((s, i) => s + (i.receivedQuantity || 0), 0);
      if (ordered > 0) { fulfilSum += (received / ordered) * 100; fulfilCount++; }
    });
    poStats.fulfilmentRate = fulfilCount > 0 ? Math.round(fulfilSum / fulfilCount) : 100;

    // ── Items supplied — aggregated per unique raw item ───────────────────────
    const itemMap = new Map();
    pos.forEach(po => {
      (po.items || []).forEach(item => {
        const key  = String(item.rawItem?._id || item.itemName || item.sku || "unknown");
        const name = item.rawItem?.name || item.itemName || "Unknown Item";
        if (!itemMap.has(key)) {
          itemMap.set(key, {
            _id: key, name,
            sku:      item.sku || item.rawItem?.sku || "",
            category: item.rawItem?.category || "—",
            unit:     item.unit || item.rawItem?.unit || "—",
            totalQty: 0, receivedQty: 0, totalValue: 0,
            orders: 0, latestPrice: 0,
          });
        }
        const r = itemMap.get(key);
        r.totalQty    += item.quantity || 0;
        r.receivedQty += item.receivedQuantity || 0;
        r.totalValue  += (item.quantity || 0) * (item.unitPrice || 0);
        r.latestPrice  = item.unitPrice || r.latestPrice;
        r.orders++;
      });
    });
    const itemsSupplied = [...itemMap.values()].sort((a, b) => b.totalValue - a.totalValue);

    // ── Payment summary ───────────────────────────────────────────────────────
    const totalInvoiced = totalInvoicedAll;
    const totalPaid     = poStats.totalPaidAmount;
    const totalDue      = poStats.totalDueAmount;

    // ── Vendor aliases: raw items where this vendor has a vendorNicknames entry ─
    // Schema field is "vendor" (ObjectId), nickname = vendor's code for the item
    const rawItemsWithAlias = await RawItem.find({
      "variants.vendorNicknames.vendor": vendor._id,
    }).select("name sku unit customUnit variants").lean();

    const vendorAliases = [];
    const vendorIdStr = String(vendor._id);
    for (const raw of rawItemsWithAlias) {
      const unit = raw.customUnit || raw.unit || "unit";
      for (const variant of (raw.variants || [])) {
        for (const vn of (variant.vendorNicknames || [])) {
          if (String(vn.vendor) !== vendorIdStr) continue;
          vendorAliases.push({
            rawItemId:          String(raw._id),
            rawItemName:        raw.name,
            rawItemSku:         raw.sku || "",
            variantId:          String(variant._id),
            variantCombination: variant.combination || [],
            vendorCode:         vn.nickname || "",   // "nickname" = vendor's item code
            price:              vn.price || 0,
            unit,
            deliveryDays:       vn.deliveryDays || 0,
            stockQty:           variant.quantity || 0,
          });
        }
      }
    }

    res.json({ success:true, vendor, purchaseOrders:pos, poStats, itemsSupplied,
      vendorAliases,
      paymentSummary:{ totalInvoiced, totalPaid, totalDue } });
  } catch (e) {
    console.error("[vendor detail]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:id/verify ─────────────────────────────────────────────────────────
router.patch("/:id/verify", async (req, res) => {
  try {
    const { signature } = req.body;
    if (!signature?.trim())
      return res.status(400).json({ success: false, message: "Signature is required." });

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });

    vendor.isVerified            = true;
    vendor.verifiedAt            = new Date();
    vendor.verifiedBy            = req.user.id;
    vendor.verifiedByName        = req.user.name || req.user.email || "CEO";
    vendor.verificationSignature = signature.trim();
    vendor.updatedBy             = req.user.id;
    await vendor.save();

    res.json({ success: true, message: "Vendor verified.", vendor });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:id/unverify ───────────────────────────────────────────────────────
router.patch("/:id/unverify", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });

    vendor.isVerified = false; vendor.verifiedAt = null;
    vendor.verifiedBy = null;  vendor.verifiedByName = null;
    vendor.verificationSignature = null; vendor.updatedBy = req.user.id;
    await vendor.save();

    res.json({ success: true, message: "Verification removed.", vendor });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /:id/status ─────────────────────────────────────────────────────────
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Active","Inactive","Blacklisted"].includes(status))
      return res.status(400).json({ success: false, message: "Invalid status." });
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });
    vendor.status = status; vendor.updatedBy = req.user.id;
    await vendor.save();
    res.json({ success: true, message: `Status updated to ${status}`, vendor });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /:id (simple — for edit forms) ────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy",  "name email");
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });
    res.json({ success: true, vendor });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const {
      companyName, vendorType, contactPerson, email, phone, alternatePhone,
      address, gstNumber, panNumber, primaryProducts, bankDetails, notes, status, rating,
    } = req.body;

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });

    if (gstNumber?.trim() && gstNumber.trim().toUpperCase() !== vendor.gstNumber) {
      const existing = await Vendor.findOne({ gstNumber: gstNumber.trim().toUpperCase(), _id: { $ne: req.params.id } });
      if (existing) return res.status(400).json({ success: false, message: "Another vendor with this GST number exists." });
    }

    if (companyName)            vendor.companyName    = companyName.trim();
    if (vendorType)             vendor.vendorType     = vendorType;
    if (contactPerson !== undefined) vendor.contactPerson = contactPerson?.trim() || "";
    if (email !== undefined)    vendor.email          = email?.trim().toLowerCase() || "";
    if (phone !== undefined)    vendor.phone          = phone?.trim() || "";
    if (alternatePhone !== undefined) vendor.alternatePhone = alternatePhone?.trim() || "";
    if (address) {
      if (address.street  !== undefined) vendor.address.street  = address.street?.trim()  || "";
      if (address.city    !== undefined) vendor.address.city    = address.city?.trim()    || "";
      if (address.state   !== undefined) vendor.address.state   = address.state?.trim()   || "";
      if (address.pincode !== undefined) vendor.address.pincode = address.pincode?.trim() || "";
      if (address.country !== undefined) vendor.address.country = address.country?.trim() || "India";
    }
    if (gstNumber !== undefined) vendor.gstNumber = gstNumber?.trim().toUpperCase() || "";
    if (panNumber !== undefined) vendor.panNumber = panNumber?.trim().toUpperCase()  || "";
    if (Array.isArray(primaryProducts))
      vendor.primaryProducts = primaryProducts.map(p => p.trim()).filter(Boolean);
    if (bankDetails) {
      if (bankDetails.accountName   !== undefined) vendor.bankDetails.accountName   = bankDetails.accountName?.trim()            || "";
      if (bankDetails.accountNumber !== undefined) vendor.bankDetails.accountNumber = bankDetails.accountNumber?.trim()          || "";
      if (bankDetails.bankName      !== undefined) vendor.bankDetails.bankName      = bankDetails.bankName?.trim()               || "";
      if (bankDetails.ifscCode      !== undefined) vendor.bankDetails.ifscCode      = bankDetails.ifscCode?.trim().toUpperCase() || "";
      if (bankDetails.branch        !== undefined) vendor.bankDetails.branch        = bankDetails.branch?.trim()                 || "";
    }
    if (notes  !== undefined) vendor.notes  = notes?.trim()  || "";
    if (status)               vendor.status = status;
    if (rating)               vendor.rating = rating;
    vendor.updatedBy = req.user.id;
    await vendor.save();

    const updated = await Vendor.findById(vendor._id)
      .populate("createdBy","name email").populate("updatedBy","name email");
    res.json({ success: true, message: "Vendor updated.", vendor: updated });
  } catch (e) {
    if (e.code === 11000)
      return res.status(400).json({ success: false, message: "Vendor with this GST number already exists." });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE /:id (soft) ────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });
    vendor.status = "Inactive"; vendor.updatedBy = req.user.id;
    await vendor.save();
    res.json({ success: true, message: "Vendor marked as inactive." });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;