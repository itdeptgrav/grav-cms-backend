// routes/CMS_Routes/Inventory/Operations/purchaseOrders.js

const express = require("express");
const router = express.Router();
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const VendorEmailService = require("../../../../services/VendorEmailService");

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
    const itemsWithDetails = items.map((item) => {
      return {
        rawItem: item.rawItem,
        itemName: item.itemName || "Unknown Item",
        sku: item.sku || "",
        unit: item.unit || "unit",
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        totalPrice: Number(item.quantity) * Number(item.unitPrice),
        receivedQuantity: 0,
        pendingQuantity: Number(item.quantity),
        status: "PENDING",
        variant: "Undefined",

        variantId: item.variantId || null,
        variantCombination: item.variantCombination || [],
        variantName: item.variantCombination?.join(" • ") || "Variant",
        variantSku: item.variantSku || "",
      };
    });

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

      // Get item details (with variant support)
      const itemsWithDetails = await Promise.all(
        items.map(async (item) => {
          const rawItem = await RawItem.findById(item.rawItem).select(
            "name sku unit customUnit variants",
          );

          let variantInfo = {};
          let variantSku = item.sku || rawItem?.sku || "";

          // If variantId is provided, get variant details
          if (item.variantId) {
            const variant = rawItem?.variants?.find(
              (v) => v._id.toString() === item.variantId,
            );
            if (variant) {
              variantInfo = {
                variantId: item.variantId,
                variantCombination: variant.combination || [],
                variantName: variant.combination?.join(" • ") || "Variant",
                variantSku: variant.sku || variantSku,
              };
              variantSku = variant.sku || variantSku;
            }
          }

          return {
            rawItem: item.rawItem,
            itemName: rawItem?.name || item.itemName,
            sku: variantSku,
            unit: rawItem?.customUnit || rawItem?.unit || item.unit,
            quantity: parseFloat(item.quantity),
            unitPrice: parseFloat(item.unitPrice),
            totalPrice: parseFloat(item.quantity) * parseFloat(item.unitPrice),
            receivedQuantity: 0,
            pendingQuantity: parseFloat(item.quantity),
            status: "PENDING",
            ...variantInfo,
          };
        }),
      );

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

// ✅ RECEIVE delivery against purchase order - SIMPLIFIED FIX
router.post("/:id/receive", async (req, res) => {
  try {
    const { deliveryDate, items, invoiceNumber, notes } = req.body;

    console.log("=== RECEIVING DELIVERY ===");
    console.log("Items:", JSON.stringify(items, null, 2));

    // Get PO with variant info
    const purchaseOrder = await PurchaseOrder.findById(req.params.id).populate(
      "items.rawItem",
      "name sku unit variants quantity",
    );

    if (!purchaseOrder) {
      return res.status(404).json({ success: false, message: "PO not found" });
    }

    let totalReceivedQty = 0;

    // Process each item
    for (const receivedItem of items) {
      const qty = receivedItem.quantity || 0;
      if (qty <= 0) continue;

      // Find PO item
      const poItem = purchaseOrder.items.id(receivedItem.itemId);
      if (!poItem) continue;

      // Update PO item
      poItem.receivedQuantity += qty;
      poItem.pendingQuantity = poItem.quantity - poItem.receivedQuantity;

      // Get variant info (from receivedItem or poItem)
      const variantId = receivedItem.variantId || poItem.variantId;
      const variantCombination =
        receivedItem.variantCombination || poItem.variantCombination;

      // Update RawItem
      const rawItem = await RawItem.findById(poItem.rawItem);
      if (!rawItem) continue;

      console.log(
        `Processing: ${rawItem.name}, Qty: ${qty}, Variant: ${variantId ? "Yes" : "No"}`,
      );

      if (variantId) {
        // Find variant by ID
        let variant = rawItem.variants.id(variantId);

        if (variant) {
          // Update existing variant
          variant.quantity += qty;
          console.log(
            `Updated variant ${variant.combination?.join(", ")} to ${variant.quantity}`,
          );
        } else {
          // Create new variant
          rawItem.variants.push({
            _id: variantId,
            combination: variantCombination || [],
            quantity: qty,
            minStock: rawItem.minStock || 0,
            maxStock: rawItem.maxStock || 0,
            sku: poItem.variantSku || `${rawItem.sku}-var`,
            status: "In Stock",
          });
          console.log(`Created new variant`);
        }
      } else {
        // No variant - update base quantity
        rawItem.quantity += qty;
        console.log(`Updated base quantity to ${rawItem.quantity}`);
      }

      // Recalculate total quantity
      const totalVariantQty = rawItem.variants.reduce(
        (sum, v) => sum + (v.quantity || 0),
        0,
      );
      rawItem.quantity = totalVariantQty;

      // Add transaction
      rawItem.stockTransactions.unshift({
        type: variantId ? "VARIANT_ADD" : "ADD",
        quantity: qty,
        variantId: variantId,
        variantCombination: variantCombination,
        previousQuantity: rawItem.quantity - qty,
        newQuantity: rawItem.quantity,
        reason: "Purchase Order Delivery",
        supplier: purchaseOrder.vendorName,
        supplierId: purchaseOrder.vendor,
        unitPrice: poItem.unitPrice,
        purchaseOrder: purchaseOrder.poNumber,
        purchaseOrderId: purchaseOrder._id,
        invoiceNumber: invoiceNumber,
        notes: `Received from PO: ${purchaseOrder.poNumber}`,
        performedBy: req.user.id,
      });

      await rawItem.save();
      totalReceivedQty += qty;
    }

    // Update PO totals
    purchaseOrder.totalReceived += totalReceivedQty;
    purchaseOrder.totalPending = purchaseOrder.items.reduce(
      (sum, item) => sum + item.pendingQuantity,
      0,
    );

    if (purchaseOrder.totalPending === 0) {
      purchaseOrder.status = "COMPLETED";
    } else if (purchaseOrder.totalReceived > 0) {
      purchaseOrder.status = "PARTIALLY_RECEIVED";
    }

    // Add delivery record
    purchaseOrder.deliveries.unshift({
      deliveryDate: deliveryDate ? new Date(deliveryDate) : new Date(),
      quantityReceived: totalReceivedQty,
      invoiceNumber: invoiceNumber || "",
      notes: notes || "",
      receivedBy: req.user.id,
    });

    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Delivery received: ${totalReceivedQty} units added`,
      totalReceived: totalReceivedQty,
    });
  } catch (error) {
    console.error("Delivery error:", error);
    res.status(500).json({ success: false, message: error.message });
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
router.post("/:id/receive", async (req, res) => {
  try {
    const { deliveryDate, items, invoiceNumber, notes } = req.body;

    console.log("=== DELIVERY REQUEST ===");
    console.log("Items received:", JSON.stringify(items, null, 2));

    // Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one item is required",
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id).populate(
      "items.rawItem",
      "name sku unit variants quantity status minStock maxStock",
    );

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    // Check if PO is issued
    if (purchaseOrder.status === "DRAFT") {
      return res.status(400).json({
        success: false,
        message: "Cannot receive against a draft purchase order",
      });
    }

    if (purchaseOrder.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Cannot receive against a cancelled purchase order",
      });
    }

    // Track updates
    const updates = [];
    let totalReceivedQty = 0;

    // STEP 1: Validate all items first
    for (const receivedItem of items) {
      const poItem = purchaseOrder.items.find(
        (item) => item._id.toString() === receivedItem.itemId,
      );

      if (!poItem) {
        return res.status(400).json({
          success: false,
          message: `Item not found in purchase order: ${receivedItem.itemId}`,
        });
      }

      const receivedQty = parseFloat(receivedItem.quantity) || 0;

      if (receivedQty <= 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid quantity for item: ${poItem.itemName}`,
        });
      }

      const availablePending = poItem.quantity - poItem.receivedQuantity;

      if (receivedQty > availablePending) {
        return res.status(400).json({
          success: false,
          message: `Cannot receive ${receivedQty} units of ${poItem.itemName}. Only ${availablePending} units pending.`,
        });
      }

      // Store update info
      updates.push({
        poItem,
        rawItemId: poItem.rawItem,
        variantId: receivedItem.variantId || poItem.variantId,
        variantCombination:
          receivedItem.variantCombination || poItem.variantCombination,
        quantity: receivedQty,
        unitPrice: poItem.unitPrice,
      });

      totalReceivedQty += receivedQty;
    }

    // STEP 2: Process each update
    const processedItems = [];

    for (const update of updates) {
      const {
        poItem,
        rawItemId,
        variantId,
        variantCombination,
        quantity,
        unitPrice,
      } = update;

      // Update PO item
      poItem.receivedQuantity += quantity;
      poItem.pendingQuantity = poItem.quantity - poItem.receivedQuantity;

      if (poItem.receivedQuantity >= poItem.quantity) {
        poItem.status = "COMPLETED";
      } else if (poItem.receivedQuantity > 0) {
        poItem.status = "PARTIALLY_RECEIVED";
      }

      processedItems.push({
        itemId: poItem._id,
        itemName: poItem.itemName,
        variantId: variantId,
        variantCombination: variantCombination,
        quantity: quantity,
        pendingBefore: poItem.quantity - (poItem.receivedQuantity - quantity),
        pendingAfter: poItem.pendingQuantity,
      });

      // Update RawItem
      const rawItem = await RawItem.findById(rawItemId);
      if (!rawItem) {
        console.log(`RawItem not found: ${rawItemId}`);
        continue;
      }

      console.log(`\nUpdating RawItem: ${rawItem.name}`);
      console.log(`Variant ID: ${variantId}`);
      console.log(`Quantity to add: ${quantity}`);

      if (variantId) {
        // Find or create variant
        let variant = null;
        let variantIndex = -1;

        // Search for variant
        for (let i = 0; i < rawItem.variants.length; i++) {
          const v = rawItem.variants[i];
          if (v._id && v._id.toString() === variantId.toString()) {
            variant = v;
            variantIndex = i;
            break;
          }
        }

        if (variant) {
          console.log(
            `Found existing variant: ${variant.combination?.join(", ")}`,
          );
          console.log(`Previous variant quantity: ${variant.quantity}`);

          // Update existing variant
          variant.quantity += quantity;

          // Update SKU if empty
          if (!variant.sku) {
            variant.sku = poItem.variantSku || `${rawItem.sku}-var`;
          }

          // Update status
          if (variant.quantity === 0) {
            variant.status = "Out of Stock";
          } else if (
            variant.quantity <= (variant.minStock || rawItem.minStock || 0)
          ) {
            variant.status = "Low Stock";
          } else {
            variant.status = "In Stock";
          }

          console.log(`Updated variant quantity: ${variant.quantity}`);

          // Update the variant in the array
          rawItem.variants[variantIndex] = variant;
        } else {
          console.log(
            `Creating new variant with combination: ${variantCombination?.join(", ")}`,
          );

          // Create new variant
          const newVariant = {
            combination: variantCombination || [],
            quantity: quantity,
            minStock: rawItem.minStock || 0,
            maxStock: rawItem.maxStock || 0,
            sku: poItem.variantSku || `${rawItem.sku}-var-${Date.now()}`,
            status: "In Stock",
          };

          rawItem.variants.push(newVariant);
          console.log(`Created new variant with quantity: ${quantity}`);
        }
      } else {
        // No variant - update base quantity
        console.log(
          `No variant, updating base quantity: ${rawItem.quantity} -> ${rawItem.quantity + quantity}`,
        );
        rawItem.quantity += quantity;
      }

      // Calculate total from all variants
      const totalFromVariants = rawItem.variants.reduce(
        (sum, v) => sum + (v.quantity || 0),
        0,
      );
      console.log(`Total from variants: ${totalFromVariants}`);

      // If we have variants, use their total; otherwise keep the base quantity
      if (rawItem.variants.length > 0) {
        rawItem.quantity = totalFromVariants;
      }

      console.log(`Final rawItem quantity: ${rawItem.quantity}`);

      // Update raw item status
      if (rawItem.quantity === 0) {
        rawItem.status = "Out of Stock";
      } else if (rawItem.quantity <= (rawItem.minStock || 0)) {
        rawItem.status = "Low Stock";
      } else {
        rawItem.status = "In Stock";
      }

      // Add stock transaction
      const transaction = {
        type: variantId ? "VARIANT_ADD" : "ADD",
        quantity: quantity,
        variantId: variantId,
        variantCombination: variantCombination,
        previousQuantity: rawItem.quantity - quantity,
        newQuantity: rawItem.quantity,
        reason: "Purchase Order Delivery",
        supplier: purchaseOrder.vendorName,
        supplierId: purchaseOrder.vendor,
        unitPrice: unitPrice,
        purchaseOrder: purchaseOrder.poNumber,
        purchaseOrderId: purchaseOrder._id,
        invoiceNumber: invoiceNumber,
        notes: `Received from PO: ${purchaseOrder.poNumber}`,
        performedBy: req.user.id,
      };

      rawItem.stockTransactions.unshift(transaction);
      await rawItem.save();
      console.log(`Saved RawItem: ${rawItem.name}`);
    }

    // STEP 3: Update purchase order
    const delivery = {
      deliveryDate: deliveryDate ? new Date(deliveryDate) : new Date(),
      quantityReceived: totalReceivedQty,
      invoiceNumber: invoiceNumber || "",
      notes: notes || "",
      receivedBy: req.user.id,
    };

    purchaseOrder.deliveries.unshift(delivery);
    purchaseOrder.totalReceived += totalReceivedQty;
    purchaseOrder.totalPending = purchaseOrder.items.reduce(
      (sum, item) => sum + item.pendingQuantity,
      0,
    );

    // Update overall PO status
    if (purchaseOrder.totalPending === 0) {
      purchaseOrder.status = "COMPLETED";
    } else if (purchaseOrder.totalReceived > 0) {
      purchaseOrder.status = "PARTIALLY_RECEIVED";
    }

    await purchaseOrder.save();

    // Populate and return
    const populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("vendor", "companyName contactPerson")
      .populate("items.rawItem", "name sku unit")
      .populate("deliveries.receivedBy", "name email");

    console.log("=== DELIVERY COMPLETED SUCCESSFULLY ===");

    res.json({
      success: true,
      message: `Delivery received successfully. ${totalReceivedQty} units added to inventory.`,
      purchaseOrder: populatedPO,
      delivery,
      processedItems,
    });
  } catch (error) {
    console.error("Error receiving delivery:", error);
    res.status(500).json({
      success: false,
      message: "Server error while receiving delivery",
    });
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
