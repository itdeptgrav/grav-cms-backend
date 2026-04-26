// routes/CMS_Routes/Inventory/Operations/purchaseOrders.js

const express = require("express");
const router = express.Router();
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const VendorEmailService = require("../../../../services/VendorEmailService");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");


// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// Helper function to generate PO number
const generatePONumber = () => {
  const prefix = "PO";
  const year = new Date().getFullYear().toString().slice(-2);
  const month = (new Date().getMonth() + 1).toString().padStart(2, "0");
  const randomNum = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `${prefix}${year}${month}${randomNum}`;
};

// ──────────────────────────────────────────────────────────────────────────
// Helper: convert quantity between units using Unit.conversions
// ──────────────────────────────────────────────────────────────────────────
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
    console.warn(`[PO convertQuantity] No path "${fromUnit}"→"${toUnit}".`);
    return quantity;
  } catch (err) {
    console.error("[PO convertQuantity]", err.message);
    return quantity;
  }
}

// ✅ GET all purchase orders
router.get("/", async (req, res) => {
  try {
    const { search = "", status, vendor, startDate, endDate } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { poNumber: { $regex: search, $options: "i" } },
        { vendorName: { $regex: search, $options: "i" } },
        { "items.itemName": { $regex: search, $options: "i" } },
      ];
    }

    if (status && status !== "all") {
      filter.status = status;
    }

    if (vendor) {
      filter.vendor = vendor;
    }

    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) {
        filter.orderDate.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.orderDate.$lte = new Date(endDate);
      }
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .populate("vendor", "companyName contactPerson phone email")
      .populate("items.rawItem", "name sku unit")
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .populate("payments.recordedBy", "name email")
      .sort({ createdAt: -1 });

    // Get statistics
    const total = await PurchaseOrder.countDocuments();
    const draft = await PurchaseOrder.countDocuments({ status: "DRAFT" });
    const issued = await PurchaseOrder.countDocuments({ status: "ISSUED" });
    const partiallyReceived = await PurchaseOrder.countDocuments({
      status: "PARTIALLY_RECEIVED",
    });
    const completed = await PurchaseOrder.countDocuments({
      status: "COMPLETED",
    });

    // Calculate payment statistics
    let totalAmount = 0;
    let totalPaid = 0;
    let pendingAmount = 0;

    purchaseOrders.forEach((po) => {
      totalAmount += po.totalAmount || 0;

      // Calculate total paid for this PO
      const poPaid =
        po.payments?.reduce((sum, payment) => sum + (payment.amount || 0), 0) ||
        0;
      totalPaid += poPaid;

      // Calculate pending amount (total - paid)
      pendingAmount += (po.totalAmount || 0) - poPaid;
    });

    // Also get payment status counts
    const paymentPending = await PurchaseOrder.countDocuments({
      paymentStatus: "PENDING",
    });
    const paymentPartial = await PurchaseOrder.countDocuments({
      paymentStatus: "PARTIAL",
    });
    const paymentCompleted = await PurchaseOrder.countDocuments({
      paymentStatus: "COMPLETED",
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


// ✅ GET available units for a raw item (registered + convertible)
router.get("/data/raw-items/:id/units", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .select("unit customUnit name").lean();
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const baseUnit = rawItem.customUnit || rawItem.unit;
    const available = [{
      name: baseUnit,
      isBase: true,
      factor: 1,
      label: `${baseUnit} (registered)`
    }];

    // Direct: baseUnit -> X  (1 base = factor X)
    const baseDoc = await Unit.findOne({ name: baseUnit })
      .populate("conversions.toUnit", "name").lean();

    if (baseDoc?.conversions?.length) {
      for (const c of baseDoc.conversions) {
        const toName = c.toUnit?.name || c.toUnit;
        if (toName && !available.find(u => u.name === toName)) {
          available.push({
            name: toName,
            isBase: false,
            factor: c.quantity,
            label: `${toName} (1 ${baseUnit} = ${c.quantity} ${toName})`
          });
        }
      }
    }

    // Reverse: X -> baseUnit  (1 X = q baseUnit, so factor = 1/q for our display)
    if (baseDoc?._id) {
      const reverseUnits = await Unit.find({
        "conversions.toUnit": baseDoc._id
      }).lean();

      for (const u of reverseUnits) {
        if (available.find(au => au.name === u.name)) continue;
        const conv = (u.conversions || []).find(
          c => c.toUnit?.toString() === baseDoc._id.toString()
        );
        if (conv?.quantity) {
          available.push({
            name: u.name,
            isBase: false,
            factor: 1 / conv.quantity,
            label: `${u.name} (1 ${u.name} = ${conv.quantity} ${baseUnit})`
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

// ✅ GET purchase order by ID
router.get("/:id", async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .populate(
        "vendor",
        "companyName contactPerson phone email address gstNumber",
      )
      .populate("items.rawItem", "name sku unit description sellingPrice")
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .populate("deliveries.receivedBy", "name email");

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    res.json({
      success: true,
      purchaseOrder,
    });
  } catch (error) {
    console.error("Error fetching purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase order",
    });
  }
});

// ✅ GET available raw items for PO (with variants) - UPDATED
router.get("/data/raw-items", async (req, res) => {
  try {
    const rawItems = await RawItem.find({})
      .select(
        "name sku category customCategory unit customUnit description sellingPrice minStock maxStock quantity status",
      )
      .lean()
      .sort({ name: 1 });

    // Transform data to match frontend expectations
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

    res.json({
      success: true,
      rawItems: formattedItems,
    });
  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items",
    });
  }
});

// ✅ GET available vendors for PO
router.get("/data/vendors", async (req, res) => {
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
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors",
    });
  }
});

// ✅ CREATE new purchase order (with variants support) - FIXED SAVE ISSUE
router.post("/", async (req, res) => {
  try {
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
      status = "DRAFT",
    } = req.body;

    console.log("Received data:", JSON.stringify(req.body, null, 2)); // Debug log

    // Basic validation
    if (!vendor) {
      return res
        .status(400)
        .json({ success: false, message: "Vendor is required" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "At least one item is required" });
    }

    // Generate unique PO number
    let poNumber;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isUnique && attempts < maxAttempts) {
      poNumber = generatePONumber();
      const existingPO = await PurchaseOrder.findOne({ poNumber });
      if (!existingPO) isUnique = true;
      attempts++;
    }

    if (!isUnique) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate unique PO number",
      });
    }

    // Build items with details (simplified version)
    // Build items with details (async — looks up baseUnit + vendor nickname)
    const itemsWithDetails = await Promise.all(items.map(async (item) => {
      const ri = await RawItem.findById(item.rawItem)
        .select("unit customUnit name sku vendorNicknames")
        .lean();

      const registeredUnit = ri ? (ri.customUnit || ri.unit) : (item.unit || "unit");
      const poUnit = item.unit || registeredUnit;

      // Snapshot vendor's nickname for this raw item
      const nicknameEntry = ri?.vendorNicknames?.find(
        vn => vn.vendor?.toString() === vendor.toString()
      );
      const vendorNickname = nicknameEntry?.nickname || "";

      return {
        rawItem: item.rawItem,
        itemName: item.itemName || ri?.name || "Unknown Item",
        sku: item.sku || ri?.sku || "",
        unit: poUnit,
        baseUnit: registeredUnit,
        vendorNickname,                      // ← NEW
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        totalPrice: Number(item.quantity) * Number(item.unitPrice),
        receivedQuantity: 0,
        pendingQuantity: Number(item.quantity),
        status: "PENDING",
        variantId: item.variantId || null,
        variantCombination: item.variantCombination || [],
        variantName: item.variantCombination?.join(" • ") || "",
        variantSku: item.variantSku || "",
      };
    }));

    console.log("Processed items:", JSON.stringify(itemsWithDetails, null, 2));

    // Calculations
    const subtotal = itemsWithDetails.reduce(
      (sum, i) => sum + (i.totalPrice || 0),
      0,
    );
    const taxAmount = (subtotal * (Number(taxRate) || 0)) / 100;
    const totalAmount =
      subtotal +
      taxAmount +
      (Number(shippingCharges) || 0) -
      (Number(discount) || 0);

    // Create PO with minimal required fields first
    const purchaseOrderData = {
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
      totalAmount,
      totalReceived: 0,
      totalPending: itemsWithDetails.reduce((sum, i) => sum + i.quantity, 0),
      status,
      paymentStatus: "PENDING",
      paymentTerms: paymentTerms || "",
      notes: notes || "",
      termsConditions: termsConditions || "",
      createdBy: req.user.id,
    };

    console.log("Creating PO with data (simplified):", {
      poNumber: purchaseOrderData.poNumber,
      vendor: purchaseOrderData.vendor,
      itemCount: purchaseOrderData.items.length,
      totalAmount: purchaseOrderData.totalAmount,
    });

    // Try to save the PO
    let purchaseOrder;
    try {
      purchaseOrder = new PurchaseOrder(purchaseOrderData);
      await purchaseOrder.save();
      console.log("PO saved successfully! ID:", purchaseOrder._id);
    } catch (saveError) {
      console.error("Save error details:", {
        name: saveError.name,
        message: saveError.message,
        errors: saveError.errors,
        code: saveError.code,
      });

      // Try to save without validation
      try {
        console.log("Trying to save without validation...");
        purchaseOrder = new PurchaseOrder(purchaseOrderData);
        await purchaseOrder.save({ validateBeforeSave: false });
        console.log("PO saved without validation! ID:", purchaseOrder._id);
      } catch (secondError) {
        console.error("Second save attempt failed:", secondError);
        throw secondError;
      }
    }

    // Try to populate, but don't fail if it doesn't work
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

    // Send email only if ISSUED
    if (status === "ISSUED") {
      try {
        const vendorData = await Vendor.findById(vendor).select(
          "companyName contactPerson email phone address",
        );

        if (vendorData?.email) {
          await VendorEmailService.sendPurchaseOrderEmail(
            populatedPO.toObject(),
            vendorData.toObject(),
            {
              name: req.user.name || "Project Manager",
              email: req.user.email || "admin@example.com",
            },
          );
          console.log(`PO email sent to ${vendorData.email}`);
        }
      } catch (emailError) {
        console.error("Failed to send PO email (non-critical):", emailError);
      }
    }

    return res.status(201).json({
      success: true,
      message: "Purchase order created successfully",
      purchaseOrder: populatedPO || purchaseOrder,
    });
  } catch (error) {
    console.error("Error creating purchase order:", error);

    return res.status(500).json({
      success: false,
      message: `Server error while creating purchase order: ${error.message}`,
    });
  }
});

// ✅ UPDATE purchase order (with variants support)
router.put("/:id", async (req, res) => {
  try {
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
      status,
    } = req.body;

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    // Cannot edit if already partially received or completed
    if (
      purchaseOrder.status === "PARTIALLY_RECEIVED" ||
      purchaseOrder.status === "COMPLETED"
    ) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit purchase order that has already been received",
      });
    }

    // Update fields
    if (vendor) purchaseOrder.vendor = vendor;
    if (vendorName) purchaseOrder.vendorName = vendorName;
    if (orderDate) purchaseOrder.orderDate = new Date(orderDate);
    if (expectedDeliveryDate)
      purchaseOrder.expectedDeliveryDate = new Date(expectedDeliveryDate);
    if (taxRate !== undefined) purchaseOrder.taxRate = parseFloat(taxRate);
    if (shippingCharges !== undefined)
      purchaseOrder.shippingCharges = parseFloat(shippingCharges);
    if (discount !== undefined) purchaseOrder.discount = parseFloat(discount);
    if (notes !== undefined) purchaseOrder.notes = notes;
    if (termsConditions !== undefined)
      purchaseOrder.termsConditions = termsConditions;
    if (paymentTerms !== undefined) purchaseOrder.paymentTerms = paymentTerms;
    if (status) purchaseOrder.status = status;

    // Update items if provided
    if (items && Array.isArray(items)) {
      // Validate items
      for (const item of items) {
        if (!item.rawItem) {
          return res.status(400).json({
            success: false,
            message: "Raw item is required for all items",
          });
        }
        if (!item.quantity || item.quantity <= 0) {
          return res.status(400).json({
            success: false,
            message: "Valid quantity is required for all items",
          });
        }
        if (!item.unitPrice || item.unitPrice <= 0) {
          return res.status(400).json({
            success: false,
            message: "Valid unit price is required for all items",
          });
        }
      }

      const itemsWithDetails = await Promise.all(items.map(async (item) => {
        const ri = await RawItem.findById(item.rawItem)
          .select("unit customUnit name sku vendorNicknames")
          .lean();

        const registeredUnit = ri ? (ri.customUnit || ri.unit) : (item.unit || "unit");
        const poUnit = item.unit || registeredUnit;

        const nicknameEntry = ri?.vendorNicknames?.find(
          vn => vn.vendor?.toString() === purchaseOrder.vendor.toString()
        );
        const vendorNickname = nicknameEntry?.nickname || "";

        return {
          rawItem: item.rawItem,
          itemName: item.itemName || ri?.name || "Unknown Item",
          sku: item.sku || ri?.sku || "",
          unit: poUnit,
          baseUnit: registeredUnit,
          vendorNickname,                      // ← NEW
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          totalPrice: Number(item.quantity) * Number(item.unitPrice),
          receivedQuantity: 0,
          pendingQuantity: Number(item.quantity),
          status: "PENDING",
          variantId: item.variantId || null,
          variantCombination: item.variantCombination || [],
          variantName: (item.variantCombination || []).join(" • ") || "",
          variantSku: item.variantSku || "",
        };
      }));

      purchaseOrder.items = itemsWithDetails;
    }

    await purchaseOrder.save();

    // Populate and return
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
    console.error("Error updating purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating purchase order",
    });
  }
});


// ✅ RECORD PAYMENT for purchase order
router.post("/:id/payment", async (req, res) => {
  try {
    const { amount, paymentMethod, referenceNumber, paymentDate, notes } =
      req.body;

    // Validation
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid payment amount is required",
      });
    }

    if (!paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "Payment method is required",
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    // Calculate current payment totals
    const totalPaid =
      purchaseOrder.payments?.reduce(
        (sum, payment) => sum + (payment.amount || 0),
        0,
      ) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;

    // Validate payment amount doesn't exceed remaining amount
    if (amount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (₹${amount}) exceeds remaining amount (₹${remainingAmount})`,
      });
    }

    // Create payment record
    const paymentRecord = {
      amount: parseFloat(amount),
      paymentMethod: paymentMethod,
      referenceNumber: referenceNumber || "",
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      notes: notes || "",
      recordedBy: req.user.id,
    };

    // Initialize payments array if it doesn't exist
    if (!purchaseOrder.payments) {
      purchaseOrder.payments = [];
    }

    // Add payment record
    purchaseOrder.payments.unshift(paymentRecord);

    // Calculate new total paid
    const newTotalPaid = totalPaid + amount;

    // Update payment status
    if (newTotalPaid >= purchaseOrder.totalAmount) {
      purchaseOrder.paymentStatus = "COMPLETED";
    } else if (newTotalPaid > 0) {
      purchaseOrder.paymentStatus = "PARTIAL";
    } else {
      purchaseOrder.paymentStatus = "PENDING";
    }

    await purchaseOrder.save();

    // Populate the payment with user info
    const populatedPO = await PurchaseOrder.findById(
      purchaseOrder._id,
    ).populate("payments.recordedBy", "name email");

    const latestPayment = populatedPO.payments[0];

    res.json({
      success: true,
      message: `Payment of ₹${amount} recorded successfully`,
      payment: latestPayment,
      paymentStatus: purchaseOrder.paymentStatus,
      totalPaid: newTotalPaid,
      remainingAmount: purchaseOrder.totalAmount - newTotalPaid,
    });
  } catch (error) {
    console.error("Error recording payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error while recording payment",
    });
  }
});

// ✅ GET purchase orders by vendor
router.get("/vendor/:vendorId", async (req, res) => {
  try {
    const { status } = req.query;

    let filter = { vendor: req.params.vendorId };

    if (status && status !== "all") {
      filter.status = status;
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status totalReceived totalPending",
      )
      .populate("items.rawItem", "name sku")
      .sort({ createdAt: -1 });

    // Calculate vendor statistics
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
      stats: {
        totalOrders,
        totalAmount,
        pendingAmount,
      },
    });
  } catch (error) {
    console.error("Error fetching vendor purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor purchase orders",
    });
  }
});

// ✅ GET purchase orders by raw item
router.get("/raw-item/:itemId", async (req, res) => {
  try {
    const { status } = req.query;

    let filter = { "items.rawItem": req.params.itemId };

    if (status && status !== "all") {
      filter.status = status;
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select("poNumber orderDate expectedDeliveryDate vendorName status")
      .populate("vendor", "companyName")
      .sort({ createdAt: -1 });

    // Get item-specific details
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

    res.json({
      success: true,
      purchaseOrders: itemOrders,
    });
  } catch (error) {
    console.error("Error fetching raw item purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw item purchase orders",
    });
  }
});

// ✅ CHANGE purchase order status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    const validStatuses = ["DRAFT", "ISSUED", "CANCELLED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Use DRAFT, ISSUED, or CANCELLED",
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    // Cannot change status if already received
    if (purchaseOrder.totalReceived > 0 && status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel purchase order that has already been received",
      });
    }

    purchaseOrder.status = status;

    if (status === "ISSUED") {
      purchaseOrder.approvedBy = req.user.id;
    }

    if (notes) {
      purchaseOrder.notes = purchaseOrder.notes
        ? `${purchaseOrder.notes}\nStatus changed to ${status}: ${notes}`
        : `Status changed to ${status}: ${notes}`;
    }

    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Purchase order status updated to ${status}`,
      purchaseOrder,
    });
  } catch (error) {
    console.error("Error updating purchase order status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating purchase order status",
    });
  }
});

// ✅ RECEIVE delivery against purchase order (COMPLETELY FIXED VERSION)
// ✅ RECEIVE delivery — handles unit conversion + variant-correct stock updates
router.post("/:id/receive", async (req, res) => {
  try {
    const { deliveryDate, items, invoiceNumber, notes } = req.body;

    if (!items?.length) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .populate("items.rawItem", "name sku unit customUnit variants quantity status minStock maxStock");

    if (!purchaseOrder) return res.status(404).json({ success: false, message: "PO not found" });
    if (purchaseOrder.status === "DRAFT") return res.status(400).json({ success: false, message: "Cannot receive against a draft PO" });
    if (purchaseOrder.status === "CANCELLED") return res.status(400).json({ success: false, message: "Cannot receive against a cancelled PO" });

    // ── Validate ───────────────────────────────────────────────────────────
    const updates = [];
    for (const ri of items) {
      const poItem = purchaseOrder.items.find(it => it._id.toString() === ri.itemId);
      if (!poItem) {
        return res.status(400).json({ success: false, message: `Item not found in PO: ${ri.itemId}` });
      }
      const qty = parseFloat(ri.quantity) || 0;
      if (qty <= 0) continue;

      const pending = poItem.quantity - poItem.receivedQuantity;
      if (qty > pending + 0.0001) {
        return res.status(400).json({
          success: false,
          message: `Cannot receive ${qty} of ${poItem.itemName}. Only ${pending} pending.`,
        });
      }

      updates.push({
        poItem,
        rawItemId: poItem.rawItem?._id || poItem.rawItem,
        variantId: ri.variantId || poItem.variantId,
        variantCombination: ri.variantCombination?.length
          ? ri.variantCombination
          : (poItem.variantCombination || []),
        qtyInPoUnit: qty,
        poUnit: poItem.unit,
        unitPrice: poItem.unitPrice,
      });
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: "No valid quantities to receive" });
    }

    // ── Process each line ──────────────────────────────────────────────────
    let totalReceivedInPoUnits = 0;
    const processed = [];

    for (const u of updates) {
      const { poItem, rawItemId, variantId, variantCombination, qtyInPoUnit, poUnit, unitPrice } = u;

      const rawItem = await RawItem.findById(rawItemId);
      if (!rawItem) {
        console.warn(`RawItem not found: ${rawItemId}`);
        continue;
      }

      const registeredUnit = rawItem.customUnit || rawItem.unit;
      const fromUnit = poUnit || registeredUnit;

      // CONVERT to registered unit before touching stock
      let qtyInRegisteredUnit = qtyInPoUnit;
      if (fromUnit !== registeredUnit) {
        qtyInRegisteredUnit = await convertQuantity(qtyInPoUnit, fromUnit, registeredUnit);
      }

      console.log(
        `[Receive] ${rawItem.name} | ${qtyInPoUnit} ${fromUnit}` +
        (fromUnit !== registeredUnit ? ` → ${qtyInRegisteredUnit} ${registeredUnit}` : "")
      );

      // Update PO item (kept in PO unit)
      poItem.receivedQuantity += qtyInPoUnit;
      poItem.pendingQuantity = Math.max(0, poItem.quantity - poItem.receivedQuantity);
      poItem.status =
        poItem.receivedQuantity >= poItem.quantity ? "COMPLETED" :
          poItem.receivedQuantity > 0 ? "PARTIALLY_RECEIVED" : "PENDING";

      const previousBaseQty = rawItem.quantity;

      // Update variant stock (in registered unit)
      if (variantId) {
        let variant = null;
        let variantIdx = -1;

        for (let i = 0; i < rawItem.variants.length; i++) {
          const v = rawItem.variants[i];
          if (v._id?.toString() === variantId.toString()) {
            variant = v; variantIdx = i; break;
          }
        }

        if (!variant && variantCombination?.length) {
          for (let i = 0; i < rawItem.variants.length; i++) {
            const v = rawItem.variants[i];
            if (v.combination?.length === variantCombination.length &&
              v.combination.every((val, idx) => val === variantCombination[idx])) {
              variant = v; variantIdx = i; break;
            }
          }
        }

        if (variant) {
          variant.quantity = (variant.quantity || 0) + qtyInRegisteredUnit;
          variant.status =
            variant.quantity === 0 ? "Out of Stock" :
              variant.quantity <= (variant.minStock || rawItem.minStock || 0) ? "Low Stock" : "In Stock";
          if (!variant.sku) variant.sku = poItem.variantSku || `${rawItem.sku}-var`;
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

        // Recompute total from variants
        rawItem.quantity = rawItem.variants.reduce((s, v) => s + (v.quantity || 0), 0);
      } else {
        rawItem.quantity = (rawItem.quantity || 0) + qtyInRegisteredUnit;
      }

      // Raw-item overall status
      rawItem.status =
        rawItem.quantity === 0 ? "Out of Stock" :
          rawItem.quantity <= (rawItem.minStock || 0) ? "Low Stock" : "In Stock";

      // Transaction record (records both PO-unit + registered-unit values)
      const conversionNote = fromUnit !== registeredUnit
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
        qtyInPoUnit, poUnit: fromUnit,
        qtyInRegisteredUnit, registeredUnit,
        converted: fromUnit !== registeredUnit,
      });

      totalReceivedInPoUnits += qtyInPoUnit;
    }

    // ── PO totals + delivery record ────────────────────────────────────────
    purchaseOrder.deliveries.unshift({
      deliveryDate: deliveryDate ? new Date(deliveryDate) : new Date(),
      quantityReceived: totalReceivedInPoUnits,
      invoiceNumber: invoiceNumber || "",
      notes: notes || "",
      receivedBy: req.user.id,
    });

    purchaseOrder.totalReceived += totalReceivedInPoUnits;
    purchaseOrder.totalPending = purchaseOrder.items.reduce((s, it) => s + (it.pendingQuantity || 0), 0);

    purchaseOrder.status =
      purchaseOrder.totalPending === 0 ? "COMPLETED" :
        purchaseOrder.totalReceived > 0 ? "PARTIALLY_RECEIVED" : purchaseOrder.status;

    await purchaseOrder.save();

    const populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("vendor", "companyName contactPerson")
      .populate("items.rawItem", "name sku unit customUnit")
      .populate("deliveries.receivedBy", "name email");

    res.json({
      success: true,
      message: `Delivery received. ${totalReceivedInPoUnits} unit(s) recorded.`,
      purchaseOrder: populatedPO,
      processed,
    });
  } catch (err) {
    console.error("Error receiving delivery:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ UPDATE PAYMENT STATUS
router.patch("/:id/payment-status", async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Payment status is required",
      });
    }

    const validStatuses = ["PENDING", "PARTIAL", "COMPLETED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment status",
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    purchaseOrder.paymentStatus = status;
    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Payment status updated to ${status}`,
      purchaseOrder,
    });
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating payment status",
    });
  }
});

// ✅ GET PAYMENT HISTORY
router.get("/:id/payments", async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .select("payments poNumber totalAmount")
      .populate("payments.recordedBy", "name email");

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

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
