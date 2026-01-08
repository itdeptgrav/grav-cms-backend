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
  const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
  const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
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
        { "items.itemName": { $regex: search, $options: "i" } }
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
      .populate("payments.recordedBy", "name email") // ADD THIS
      .sort({ createdAt: -1 });

    // Get statistics
    const total = await PurchaseOrder.countDocuments();
    const draft = await PurchaseOrder.countDocuments({ status: "DRAFT" });
    const issued = await PurchaseOrder.countDocuments({ status: "ISSUED" });
    const partiallyReceived = await PurchaseOrder.countDocuments({ status: "PARTIALLY_RECEIVED" });
    const completed = await PurchaseOrder.countDocuments({ status: "COMPLETED" });

    // Calculate payment statistics
    let totalAmount = 0;
    let totalPaid = 0;
    let pendingAmount = 0;

    purchaseOrders.forEach(po => {
      totalAmount += po.totalAmount || 0;

      // Calculate total paid for this PO
      const poPaid = po.payments?.reduce((sum, payment) => sum + (payment.amount || 0), 0) || 0;
      totalPaid += poPaid;

      // Calculate pending amount (total - paid)
      pendingAmount += (po.totalAmount || 0) - poPaid;
    });

    // Also get payment status counts
    const paymentPending = await PurchaseOrder.countDocuments({ paymentStatus: "PENDING" });
    const paymentPartial = await PurchaseOrder.countDocuments({ paymentStatus: "PARTIAL" });
    const paymentCompleted = await PurchaseOrder.countDocuments({ paymentStatus: "COMPLETED" });

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
        totalPaid, // ADD THIS
        pendingAmount, // This is now correctly calculated
        paymentPending,
        paymentPartial,
        paymentCompleted
      }
    });

  } catch (error) {
    console.error("Error fetching purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase orders"
    });
  }
});

// ✅ GET purchase order by ID
router.get("/:id", async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .populate("vendor", "companyName contactPerson phone email address gstNumber")
      .populate("items.rawItem", "name sku unit description sellingPrice")
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .populate("deliveries.receivedBy", "name email");

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    res.json({
      success: true,
      purchaseOrder
    });

  } catch (error) {
    console.error("Error fetching purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase order"
    });
  }
});

// ✅ GET available raw items for PO
router.get("/data/raw-items", async (req, res) => {
  try {
    const rawItems = await RawItem.find({})
      .select("name sku category unit customUnit description sellingPrice minStock maxStock quantity status")
      .sort({ name: 1 });

    const formattedItems = rawItems.map(item => ({
      id: item._id,
      name: item.name,
      sku: item.sku,
      category: item.customCategory || item.category,
      unit: item.customUnit || item.unit,
      description: item.description,
      sellingPrice: item.sellingPrice,
      currentStock: item.quantity,
      minStock: item.minStock,
      maxStock: item.maxStock,
      status: item.status
    }));

    res.json({
      success: true,
      rawItems: formattedItems
    });

  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items"
    });
  }
});

// ✅ GET available vendors for PO
router.get("/data/vendors", async (req, res) => {
  try {
    const vendors = await Vendor.find({ status: "Active" })
      .select("companyName contactPerson phone email address gstNumber vendorType paymentTerms")
      .sort({ companyName: 1 });

    res.json({
      success: true,
      vendors: vendors.map(v => ({
        id: v._id,
        name: v.companyName,
        contactPerson: v.contactPerson,
        phone: v.phone,
        email: v.email,
        address: v.address,
        gstNumber: v.gstNumber,
        vendorType: v.vendorType,
        paymentTerms: v.paymentTerms
      }))
    });

  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors"
    });
  }
});

// ✅ CREATE new purchase order
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
      status = "DRAFT"
    } = req.body;

    // Basic validation
    if (!vendor) {
      return res.status(400).json({ success: false, message: "Vendor is required" });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    for (const item of items) {
      if (!item.rawItem) {
        return res.status(400).json({ success: false, message: "Raw item is required for all items" });
      }
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ success: false, message: "Valid quantity is required" });
      }
      if (!item.unitPrice || item.unitPrice <= 0) {
        return res.status(400).json({ success: false, message: "Valid unit price is required" });
      }
    }

    // Generate unique PO number
    let poNumber;
    let isUnique = false;
    while (!isUnique) {
      poNumber = generatePONumber();
      const existingPO = await PurchaseOrder.findOne({ poNumber });
      if (!existingPO) isUnique = true;
    }

    // Build items with details
    const itemsWithDetails = await Promise.all(
      items.map(async (item) => {
        const rawItem = await RawItem.findById(item.rawItem)
          .select("name sku unit customUnit");

        return {
          rawItem: item.rawItem,
          itemName: rawItem?.name || item.itemName,
          sku: rawItem?.sku || item.sku,
          unit: rawItem?.customUnit || rawItem?.unit || item.unit,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          totalPrice: Number(item.quantity) * Number(item.unitPrice),
          receivedQuantity: 0,
          pendingQuantity: Number(item.quantity),
          status: "PENDING"
        };
      })
    );

    // Calculations
    const subtotal = itemsWithDetails.reduce((sum, i) => sum + i.totalPrice, 0);
    const taxAmount = (subtotal * (Number(taxRate) || 0)) / 100;
    const totalAmount =
      subtotal +
      taxAmount +
      (Number(shippingCharges) || 0) -
      (Number(discount) || 0);

    // Create PO
    const purchaseOrder = new PurchaseOrder({
      poNumber,
      vendor,
      vendorName,
      orderDate: orderDate ? new Date(orderDate) : new Date(),
      expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
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
      createdBy: req.user.id
    });

    await purchaseOrder.save();

    // Populate PO
    const populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("vendor", "companyName contactPerson email phone address")
      .populate("items.rawItem", "name sku unit")
      .populate("createdBy", "name email");

    // Send email only if ISSUED

    try {
      // Fetch vendor info
      const vendorData = await Vendor.findById(vendor)
        .select("companyName contactPerson email phone address");

      // Send email only if vendor has an email
      if (vendorData?.email) {
        await VendorEmailService.sendPurchaseOrderEmail(
          populatedPO.toObject(),   // PO data
          vendorData.toObject(),    // Vendor data including email
          {
            name: req.user.name || "Project Manager",  // Sender info
            email: req.user.email || "biswalpramod3.1415@gmail.com"
          }
        );
        console.log(`PO email sent to ${vendorData.email}`);
      } else {
        console.log(`Vendor email not found for PO ${poNumber}`);
      }
    } catch (emailError) {
      console.error("Failed to send PO email:", emailError);
    }



    return res.status(201).json({
      success: true,
      message: "Purchase order created successfully",
      purchaseOrder: populatedPO
    });

  } catch (error) {
    console.error("Error creating purchase order:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while creating purchase order"
    });
  }
});


// ✅ UPDATE purchase order
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
      status
    } = req.body;

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    // Cannot edit if already partially received or completed
    if (purchaseOrder.status === "PARTIALLY_RECEIVED" || purchaseOrder.status === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "Cannot edit purchase order that has already been received"
      });
    }

    // Update fields
    if (vendor) purchaseOrder.vendor = vendor;
    if (vendorName) purchaseOrder.vendorName = vendorName;
    if (orderDate) purchaseOrder.orderDate = new Date(orderDate);
    if (expectedDeliveryDate) purchaseOrder.expectedDeliveryDate = new Date(expectedDeliveryDate);
    if (taxRate !== undefined) purchaseOrder.taxRate = parseFloat(taxRate);
    if (shippingCharges !== undefined) purchaseOrder.shippingCharges = parseFloat(shippingCharges);
    if (discount !== undefined) purchaseOrder.discount = parseFloat(discount);
    if (notes !== undefined) purchaseOrder.notes = notes;
    if (termsConditions !== undefined) purchaseOrder.termsConditions = termsConditions;
    if (paymentTerms !== undefined) purchaseOrder.paymentTerms = paymentTerms;
    if (status) purchaseOrder.status = status;

    // Update items if provided
    if (items && Array.isArray(items)) {
      // Validate items
      for (const item of items) {
        if (!item.rawItem) {
          return res.status(400).json({
            success: false,
            message: "Raw item is required for all items"
          });
        }
        if (!item.quantity || item.quantity <= 0) {
          return res.status(400).json({
            success: false,
            message: "Valid quantity is required for all items"
          });
        }
        if (!item.unitPrice || item.unitPrice <= 0) {
          return res.status(400).json({
            success: false,
            message: "Valid unit price is required for all items"
          });
        }
      }

      // Get item details
      const itemsWithDetails = await Promise.all(items.map(async (item) => {
        const rawItem = await RawItem.findById(item.rawItem)
          .select("name sku unit customUnit");

        return {
          rawItem: item.rawItem,
          itemName: rawItem?.name || item.itemName,
          sku: rawItem?.sku || item.sku,
          unit: rawItem?.customUnit || rawItem?.unit || item.unit,
          quantity: parseFloat(item.quantity),
          unitPrice: parseFloat(item.unitPrice),
          totalPrice: parseFloat(item.quantity) * parseFloat(item.unitPrice),
          receivedQuantity: 0,
          pendingQuantity: parseFloat(item.quantity),
          status: "PENDING"
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
      purchaseOrder: populatedPO
    });

  } catch (error) {
    console.error("Error updating purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating purchase order"
    });
  }
});

// ✅ DELETE purchase order
router.delete("/:id", async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    // Cannot delete if already received
    if (purchaseOrder.totalReceived > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete purchase order that has already been received"
      });
    }

    await purchaseOrder.deleteOne();

    res.json({
      success: true,
      message: "Purchase order deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting purchase order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting purchase order"
    });
  }
});

// ✅ RECEIVE delivery against purchase order
router.post("/:id/receive", async (req, res) => {
  try {
    const {
      deliveryDate,
      items,
      invoiceNumber,
      notes
    } = req.body;

    // Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one item is required"
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .populate("items.rawItem", "name sku unit");

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    // Check if PO is issued
    if (purchaseOrder.status === "DRAFT") {
      return res.status(400).json({
        success: false,
        message: "Cannot receive against a draft purchase order"
      });
    }

    if (purchaseOrder.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Cannot receive against a cancelled purchase order"
      });
    }

    // Validate and process items
    const processedItems = [];
    let totalReceivedQty = 0;

    for (const receivedItem of items) {
      const poItem = purchaseOrder.items.find(item =>
        item._id.toString() === receivedItem.itemId
      );

      if (!poItem) {
        return res.status(400).json({
          success: false,
          message: `Item not found in purchase order: ${receivedItem.itemId}`
        });
      }

      const receivedQty = parseFloat(receivedItem.quantity) || 0;

      if (receivedQty <= 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid quantity for item: ${poItem.itemName}`
        });
      }

      const availablePending = poItem.quantity - poItem.receivedQuantity;

      if (receivedQty > availablePending) {
        return res.status(400).json({
          success: false,
          message: `Cannot receive ${receivedQty} units of ${poItem.itemName}. Only ${availablePending} units pending.`
        });
      }

      // Update PO item
      poItem.receivedQuantity += receivedQty;
      poItem.pendingQuantity = poItem.quantity - poItem.receivedQuantity;

      // Update item status
      if (poItem.receivedQuantity >= poItem.quantity) {
        poItem.status = "COMPLETED";
      } else if (poItem.receivedQuantity > 0) {
        poItem.status = "PARTIALLY_RECEIVED";
      }

      processedItems.push({
        itemId: poItem._id,
        itemName: poItem.itemName,
        quantity: receivedQty,
        pendingBefore: availablePending,
        pendingAfter: poItem.pendingQuantity
      });

      totalReceivedQty += receivedQty;
    }

    // Create delivery record
    const delivery = {
      deliveryDate: deliveryDate ? new Date(deliveryDate) : new Date(),
      quantityReceived: totalReceivedQty,
      invoiceNumber: invoiceNumber || "",
      notes: notes || "",
      receivedBy: req.user.id
    };

    purchaseOrder.deliveries.unshift(delivery);
    purchaseOrder.totalReceived += totalReceivedQty;
    purchaseOrder.totalPending = purchaseOrder.items.reduce((sum, item) => sum + item.pendingQuantity, 0);

    // Update overall PO status
    if (purchaseOrder.totalPending === 0) {
      purchaseOrder.status = "COMPLETED";
    } else if (purchaseOrder.totalReceived > 0) {
      purchaseOrder.status = "PARTIALLY_RECEIVED";
    }

    await purchaseOrder.save();

    // Update raw item quantities
    for (const receivedItem of items) {
      const poItem = purchaseOrder.items.find(item =>
        item._id.toString() === receivedItem.itemId
      );

      if (poItem && poItem.rawItem) {
        const rawItem = await RawItem.findById(poItem.rawItem);
        if (rawItem) {
          const receivedQty = parseFloat(receivedItem.quantity) || 0;

          // Add to raw item quantity
          rawItem.quantity += receivedQty;

          // Add stock transaction
          const transaction = {
            type: "ADD",
            quantity: receivedQty,
            previousQuantity: rawItem.quantity - receivedQty,
            newQuantity: rawItem.quantity,
            reason: "Purchase Order Delivery",
            supplier: purchaseOrder.vendorName,
            supplierId: purchaseOrder.vendor,
            unitPrice: poItem.unitPrice,
            purchaseOrder: purchaseOrder.poNumber,
            purchaseOrderId: purchaseOrder._id,
            invoiceNumber: invoiceNumber,
            notes: `Received from PO: ${purchaseOrder.poNumber}`,
            performedBy: req.user.id
          };

          rawItem.stockTransactions.unshift(transaction);
          await rawItem.save();
        }
      }
    }

    // Populate and return
    const populatedPO = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("vendor", "companyName contactPerson")
      .populate("items.rawItem", "name sku unit")
      .populate("deliveries.receivedBy", "name email");

    res.json({
      success: true,
      message: `Delivery received successfully. ${totalReceivedQty} units added to inventory.`,
      purchaseOrder: populatedPO,
      delivery,
      processedItems
    });

  } catch (error) {
    console.error("Error receiving delivery:", error);
    res.status(500).json({
      success: false,
      message: "Server error while receiving delivery"
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
      .select("poNumber orderDate expectedDeliveryDate totalAmount status totalReceived totalPending")
      .populate("items.rawItem", "name sku")
      .sort({ createdAt: -1 });

    // Calculate vendor statistics
    const totalOrders = purchaseOrders.length;
    const totalAmount = purchaseOrders.reduce((sum, po) => sum + (po.totalAmount || 0), 0);
    const pendingAmount = purchaseOrders
      .filter(po => po.status !== "COMPLETED" && po.status !== "CANCELLED")
      .reduce((sum, po) => sum + (po.totalAmount || 0), 0);

    res.json({
      success: true,
      purchaseOrders,
      stats: {
        totalOrders,
        totalAmount,
        pendingAmount
      }
    });

  } catch (error) {
    console.error("Error fetching vendor purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor purchase orders"
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
    const itemOrders = purchaseOrders.map(po => {
      const item = po.items.find(i => i.rawItem.toString() === req.params.itemId);
      return {
        _id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        vendorName: po.vendorName,
        status: po.status,
        itemDetails: item ? {
          quantity: item.quantity,
          receivedQuantity: item.receivedQuantity,
          pendingQuantity: item.pendingQuantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: item.status
        } : null
      };
    });

    res.json({
      success: true,
      purchaseOrders: itemOrders
    });

  } catch (error) {
    console.error("Error fetching raw item purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw item purchase orders"
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
        message: "Status is required"
      });
    }

    const validStatuses = ["DRAFT", "ISSUED", "CANCELLED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Use DRAFT, ISSUED, or CANCELLED"
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    // Cannot change status if already received
    if (purchaseOrder.totalReceived > 0 && status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel purchase order that has already been received"
      });
    }

    purchaseOrder.status = status;

    if (status === "ISSUED") {
      purchaseOrder.approvedBy = req.user.id;
    }

    if (notes) {
      purchaseOrder.notes = purchaseOrder.notes ?
        `${purchaseOrder.notes}\nStatus changed to ${status}: ${notes}` :
        `Status changed to ${status}: ${notes}`;
    }

    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Purchase order status updated to ${status}`,
      purchaseOrder
    });

  } catch (error) {
    console.error("Error updating purchase order status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating purchase order status"
    });
  }
});


// Add these routes to your existing purchaseOrders.js file

// ✅ RECORD PAYMENT against purchase order
router.post("/:id/payment", async (req, res) => {
  try {
    const {
      amount,
      paymentMethod,
      referenceNumber,
      notes
    } = req.body;

    // Validation
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid payment amount is required"
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    // Calculate total paid so far
    const totalPaid = purchaseOrder.payments?.reduce((sum, payment) => sum + payment.amount, 0) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;

    if (amount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment amount cannot exceed remaining amount of ${remainingAmount}`
      });
    }

    // Create payment record
    const payment = {
      date: new Date(),
      amount: parseFloat(amount),
      paymentMethod: paymentMethod || "BANK_TRANSFER",
      referenceNumber: referenceNumber || "",
      notes: notes || "",
      recordedBy: req.user.id
    };

    // Add payment to purchase order
    if (!purchaseOrder.payments) {
      purchaseOrder.payments = [];
    }
    purchaseOrder.payments.push(payment);

    // Update payment status
    const newTotalPaid = totalPaid + parseFloat(amount);

    if (newTotalPaid >= purchaseOrder.totalAmount) {
      purchaseOrder.paymentStatus = "COMPLETED";
    } else if (newTotalPaid > 0) {
      purchaseOrder.paymentStatus = "PARTIAL";
    } else {
      purchaseOrder.paymentStatus = "PENDING";
    }

    await purchaseOrder.save();

    res.json({
      success: true,
      message: "Payment recorded successfully",
      payment,
      paymentStatus: purchaseOrder.paymentStatus,
      totalPaid: newTotalPaid,
      remainingAmount: purchaseOrder.totalAmount - newTotalPaid
    });

  } catch (error) {
    console.error("Error recording payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error while recording payment"
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
        message: "Payment status is required"
      });
    }

    const validStatuses = ["PENDING", "PARTIAL", "COMPLETED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment status"
      });
    }

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found"
      });
    }

    purchaseOrder.paymentStatus = status;
    await purchaseOrder.save();

    res.json({
      success: true,
      message: `Payment status updated to ${status}`,
      purchaseOrder
    });

  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating payment status"
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
        message: "Purchase order not found"
      });
    }

    const totalPaid = purchaseOrder.payments?.reduce((sum, payment) => sum + payment.amount, 0) || 0;
    const remainingAmount = purchaseOrder.totalAmount - totalPaid;

    res.json({
      success: true,
      payments: purchaseOrder.payments || [],
      totalPaid,
      remainingAmount,
      poNumber: purchaseOrder.poNumber,
      totalAmount: purchaseOrder.totalAmount
    });

  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching payments"
    });
  }
});

module.exports = router;