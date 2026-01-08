// routes/Cms_routes/HistoryReport/vendor.js

const express = require("express");
const router = express.Router();
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Vendor types for clothing industry
const VENDOR_TYPES = [
  "Raw Material Supplier",
  "Fabric Supplier", 
  "Accessories Supplier",
  "Packaging Supplier",
  "Equipment Supplier",
  "Logistics",
  "Other"
];

// Common products for clothing industry
const COMMON_PRODUCTS = [
  "Cotton Fabric",
  "Polyester Fabric",
  "Silk Fabric",
  "Denim Fabric",
  "Linen Fabric",
  "Zippers",
  "Buttons",
  "Threads",
  "Labels",
  "Tags",
  "Packaging Boxes",
  "Polybags",
  "Hangers",
  "Sewing Machines",
  "Cutting Machines",
  "Embroidery Machines",
  "Fusing Machines",
  "Ironing Equipment",
  "Transport Services",
  "Warehousing"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all vendors with optional search/filter
router.get("/", async (req, res) => {
  try {
    const { search = "", status, vendorType } = req.query;
    
    let filter = {};
    
    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { contactPerson: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } }
      ];
    }
    
    if (status) {
      filter.status = status;
    }
    
    if (vendorType) {
      filter.vendorType = vendorType;
    }
    
    const vendors = await Vendor.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ createdAt: -1 });
    
    // Get statistics
    const total = await Vendor.countDocuments();
    const active = await Vendor.countDocuments({ status: "Active" });
    const fabricSuppliers = await Vendor.countDocuments({ vendorType: "Fabric Supplier" });
    
    res.json({
      success: true,
      vendors,
      stats: { 
        total, 
        active, 
        fabricSuppliers
      },
      filters: {
        types: VENDOR_TYPES,
        statuses: ["Active", "Inactive", "Blacklisted"],
        commonProducts: COMMON_PRODUCTS
      }
    });
    
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching vendors" 
    });
  }
});

// ✅ GET vendor types
router.get("/types", async (req, res) => {
  res.json({
    success: true,
    types: VENDOR_TYPES
  });
});

// ✅ GET common products
router.get("/common-products", async (req, res) => {
  res.json({
    success: true,
    products: COMMON_PRODUCTS
  });
});

// ✅ GET vendor by ID
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    res.json({ success: true, vendor });
    
  } catch (error) {
    console.error("Error fetching vendor:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching vendor" 
    });
  }
});

// ✅ CREATE new vendor
router.post("/", async (req, res) => {
  try {
    const {
      companyName,
      vendorType,
      contactPerson,
      email,
      phone,
      alternatePhone,
      address,
      gstNumber,
      panNumber,
      primaryProducts,
      bankDetails,
      notes,
      status,
      rating
    } = req.body;
    
    // Validation - Only companyName is required
    if (!companyName || !companyName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Company name is required"
      });
    }
    
    // Check for duplicate GST number if provided
    if (gstNumber && gstNumber.trim()) {
      const existingVendor = await Vendor.findOne({ 
        gstNumber: gstNumber.trim().toUpperCase() 
      });
      
      if (existingVendor) {
        return res.status(400).json({
          success: false,
          message: "Vendor with this GST number already exists"
        });
      }
    }
    
    // Process primary products
    let processedProducts = [];
    if (primaryProducts && Array.isArray(primaryProducts)) {
      processedProducts = primaryProducts
        .map(product => product.trim())
        .filter(product => product !== "");
    }
    
    // Create new vendor
    const newVendor = new Vendor({
      companyName: companyName.trim(),
      vendorType: vendorType || "Raw Material Supplier",
      contactPerson: contactPerson ? contactPerson.trim() : "",
      email: email ? email.trim().toLowerCase() : "",
      phone: phone ? phone.trim() : "",
      alternatePhone: alternatePhone ? alternatePhone.trim() : "",
      address: {
        street: address?.street ? address.street.trim() : "",
        city: address?.city ? address.city.trim() : "",
        state: address?.state ? address.state.trim() : "",
        pincode: address?.pincode ? address.pincode.trim() : "",
        country: address?.country ? address.country.trim() : "India"
      },
      gstNumber: gstNumber ? gstNumber.trim().toUpperCase() : "",
      panNumber: panNumber ? panNumber.trim().toUpperCase() : "",
      primaryProducts: processedProducts,
      bankDetails: {
        accountName: bankDetails?.accountName ? bankDetails.accountName.trim() : "",
        accountNumber: bankDetails?.accountNumber ? bankDetails.accountNumber.trim() : "",
        bankName: bankDetails?.bankName ? bankDetails.bankName.trim() : "",
        ifscCode: bankDetails?.ifscCode ? bankDetails.ifscCode.trim().toUpperCase() : "",
        branch: bankDetails?.branch ? bankDetails.branch.trim() : ""
      },
      notes: notes ? notes.trim() : "",
      status: status || "Active",
      rating: rating || 3,
      createdBy: req.user.id
    });
    
    await newVendor.save();
    
    res.status(201).json({
      success: true,
      message: "Vendor registered successfully",
      vendor: newVendor
    });
    
  } catch (error) {
    console.error("Error creating vendor:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Vendor with this GST number already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while creating vendor" 
    });
  }
});

// ✅ UPDATE vendor
router.put("/:id", async (req, res) => {
  try {
    const {
      companyName,
      vendorType,
      contactPerson,
      email,
      phone,
      alternatePhone,
      address,
      gstNumber,
      panNumber,
      primaryProducts,
      bankDetails,
      notes,
      status,
      rating
    } = req.body;
    
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    // Check for duplicate GST number if changed
    if (gstNumber && gstNumber.trim() && gstNumber.trim().toUpperCase() !== vendor.gstNumber) {
      const existingVendor = await Vendor.findOne({ 
        gstNumber: gstNumber.trim().toUpperCase(),
        _id: { $ne: req.params.id }
      });
      
      if (existingVendor) {
        return res.status(400).json({
          success: false,
          message: "Another vendor with this GST number already exists"
        });
      }
    }
    
    // Update fields if provided
    if (companyName) vendor.companyName = companyName.trim();
    if (vendorType) vendor.vendorType = vendorType;
    if (contactPerson !== undefined) vendor.contactPerson = contactPerson ? contactPerson.trim() : "";
    if (email !== undefined) vendor.email = email ? email.trim().toLowerCase() : "";
    if (phone !== undefined) vendor.phone = phone ? phone.trim() : "";
    if (alternatePhone !== undefined) vendor.alternatePhone = alternatePhone ? alternatePhone.trim() : "";
    
    // Update address if provided
    if (address) {
      if (address.street !== undefined) vendor.address.street = address.street ? address.street.trim() : "";
      if (address.city !== undefined) vendor.address.city = address.city ? address.city.trim() : "";
      if (address.state !== undefined) vendor.address.state = address.state ? address.state.trim() : "";
      if (address.pincode !== undefined) vendor.address.pincode = address.pincode ? address.pincode.trim() : "";
      if (address.country !== undefined) vendor.address.country = address.country ? address.country.trim() : "India";
    }
    
    if (gstNumber !== undefined) vendor.gstNumber = gstNumber ? gstNumber.trim().toUpperCase() : "";
    if (panNumber !== undefined) vendor.panNumber = panNumber ? panNumber.trim().toUpperCase() : "";
    
    // Update primary products
    if (primaryProducts !== undefined) {
      if (Array.isArray(primaryProducts)) {
        vendor.primaryProducts = primaryProducts
          .map(product => product.trim())
          .filter(product => product !== "");
      }
    }
    
    // Update bank details if provided
    if (bankDetails) {
      if (bankDetails.accountName !== undefined) vendor.bankDetails.accountName = bankDetails.accountName ? bankDetails.accountName.trim() : "";
      if (bankDetails.accountNumber !== undefined) vendor.bankDetails.accountNumber = bankDetails.accountNumber ? bankDetails.accountNumber.trim() : "";
      if (bankDetails.bankName !== undefined) vendor.bankDetails.bankName = bankDetails.bankName ? bankDetails.bankName.trim() : "";
      if (bankDetails.ifscCode !== undefined) vendor.bankDetails.ifscCode = bankDetails.ifscCode ? bankDetails.ifscCode.trim().toUpperCase() : "";
      if (bankDetails.branch !== undefined) vendor.bankDetails.branch = bankDetails.branch ? bankDetails.branch.trim() : "";
    }
    
    if (notes !== undefined) vendor.notes = notes ? notes.trim() : "";
    if (status) vendor.status = status;
    if (rating) vendor.rating = rating;
    
    vendor.updatedBy = req.user.id;
    await vendor.save();
    
    const updatedVendor = await Vendor.findById(vendor._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    res.json({
      success: true,
      message: "Vendor updated successfully",
      vendor: updatedVendor
    });
    
  } catch (error) {
    console.error("Error updating vendor:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Vendor with this GST number already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating vendor" 
    });
  }
});

// ✅ DELETE vendor
router.delete("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    // Soft delete by changing status to Inactive
    vendor.status = "Inactive";
    vendor.updatedBy = req.user.id;
    await vendor.save();
    
    res.json({
      success: true,
      message: "Vendor marked as inactive"
    });
    
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while deleting vendor" 
    });
  }
});

// ✅ UPDATE vendor status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!["Active", "Inactive", "Blacklisted"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value"
      });
    }
    
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    vendor.status = status;
    vendor.updatedBy = req.user.id;
    await vendor.save();
    
    res.json({
      success: true,
      message: `Vendor status updated to ${status}`,
      vendor
    });
    
  } catch (error) {
    console.error("Error updating vendor status:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating vendor status" 
    });
  }
});




// ✅ GET vendor purchase orders
router.get("/:id/purchase-orders", async (req, res) => {
  try {
    const { status, startDate, endDate, limit = 10 } = req.query;
    
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    let filter = { vendor: req.params.id };
    
    if (status && status !== "all") {
      filter.status = status;
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
      .select("poNumber orderDate expectedDeliveryDate totalAmount status items totalReceived totalPending deliveries payments")
      .populate("items.rawItem", "name sku unit")
      .sort({ orderDate: -1 })
      .limit(parseInt(limit));
    
    // Calculate total spent and pending
    const totalSpent = purchaseOrders
      .filter(po => po.status === "COMPLETED")
      .reduce((sum, po) => sum + po.totalAmount, 0);
    
    const pendingOrders = purchaseOrders.filter(po => 
      po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED"
    );
    
    const totalPendingAmount = pendingOrders.reduce((sum, po) => sum + po.totalAmount, 0);
    
    // Format the response
    const formattedOrders = purchaseOrders.map(po => {
      const totalOrdered = po.items.reduce((sum, item) => sum + item.quantity, 0);
      const totalDelivered = po.totalReceived || 0;
      const pending = totalOrdered - totalDelivered;
      
      return {
        _id: po._id,
        poNumber: po.poNumber,
        date: po.orderDate,
        status: po.status,
        totalAmount: po.totalAmount,
        items: po.items.map(item => ({
          name: item.rawItem?.name || item.itemName,
          sku: item.sku,
          unit: item.unit,
          quantity: item.quantity,
          delivered: item.receivedQuantity || 0,
          pending: item.pendingQuantity || item.quantity
        })),
        delivered: totalDelivered,
        pending: pending,
        deliveryDate: po.expectedDeliveryDate,
        progress: totalOrdered > 0 ? Math.round((totalDelivered / totalOrdered) * 100) : 0
      };
    });
    
    res.json({
      success: true,
      purchaseOrders: formattedOrders,
      stats: {
        totalOrders: purchaseOrders.length,
        completedOrders: purchaseOrders.filter(po => po.status === "COMPLETED").length,
        pendingOrders: pendingOrders.length,
        cancelledOrders: purchaseOrders.filter(po => po.status === "CANCELLED").length,
        totalSpent,
        totalPendingAmount
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

// ✅ GET vendor transactions (payments)
router.get("/:id/transactions", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    // Get all purchase orders for this vendor
    const purchaseOrders = await PurchaseOrder.find({ vendor: req.params.id })
      .select("poNumber totalAmount payments orderDate")
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });
    
    // Extract all payments
    const allTransactions = [];
    
    purchaseOrders.forEach(po => {
      if (po.payments && Array.isArray(po.payments)) {
        po.payments.forEach(payment => {
          allTransactions.push({
            _id: payment._id,
            date: payment.date || payment.createdAt,
            type: "Payment",
            poNumber: po.poNumber,
            amount: payment.amount,
            status: "Paid", // Since it's recorded as payment
            paymentMethod: payment.paymentMethod,
            referenceNumber: payment.referenceNumber,
            recordedBy: payment.recordedBy
          });
        });
      }
      
      // Also add the PO as a transaction (if not fully paid)
      const totalPaid = po.payments?.reduce((sum, p) => sum + p.amount, 0) || 0;
      const remaining = po.totalAmount - totalPaid;
      
      if (remaining > 0) {
        allTransactions.push({
          _id: po._id,
          date: po.orderDate,
          type: "Purchase Order",
          poNumber: po.poNumber,
          amount: remaining,
          status: po.paymentStatus,
          paymentMethod: "Pending",
          referenceNumber: "",
          recordedBy: null
        });
      }
    });
    
    // Sort by date (newest first)
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Get total amounts
    const totalPaid = allTransactions
      .filter(t => t.type === "Payment")
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalPending = allTransactions
      .filter(t => t.status === "PENDING" || t.status === "PARTIAL")
      .reduce((sum, t) => sum + t.amount, 0);
    
    res.json({
      success: true,
      transactions: allTransactions,
      stats: {
        totalTransactions: allTransactions.length,
        totalPaid,
        totalPending,
        paidTransactions: allTransactions.filter(t => t.type === "Payment").length
      }
    });
    
  } catch (error) {
    console.error("Error fetching vendor transactions:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor transactions"
    });
  }
});

// ✅ GET items supplied by vendor
router.get("/:id/items-supplied", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    // Get all purchase orders for this vendor
    const purchaseOrders = await PurchaseOrder.find({ vendor: req.params.id })
      .select("items orderDate")
      .populate("items.rawItem", "name sku unit category")
      .sort({ orderDate: -1 });
    
    // Aggregate items by rawItem
    const itemMap = new Map();
    const itemLastOrderMap = new Map();
    const itemPriceMap = new Map();
    
    purchaseOrders.forEach(po => {
      po.items.forEach(item => {
        const itemId = item.rawItem?._id || item.itemName;
        
        if (!itemMap.has(itemId)) {
          itemMap.set(itemId, {
            rawItem: item.rawItem?._id,
            name: item.rawItem?.name || item.itemName,
            sku: item.sku || `ITEM-${itemId}`,
            category: item.rawItem?.category || "Uncategorized",
            totalQuantity: 0,
            totalValue: 0,
            orders: 0,
            totalDelivered: 0
          });
        }
        
        const itemData = itemMap.get(itemId);
        itemData.totalQuantity += item.quantity;
        itemData.totalValue += (item.quantity * item.unitPrice);
        itemData.orders += 1;
        itemData.totalDelivered += (item.receivedQuantity || 0);
        
        // Track last order date
        if (!itemLastOrderMap.has(itemId) || 
            new Date(po.orderDate) > new Date(itemLastOrderMap.get(itemId))) {
          itemLastOrderMap.set(itemId, po.orderDate);
        }
        
        // Track average price (weighted by quantity)
        if (!itemPriceMap.has(itemId)) {
          itemPriceMap.set(itemId, {
            totalPrice: 0,
            totalQty: 0
          });
        }
        const priceData = itemPriceMap.get(itemId);
        priceData.totalPrice += (item.quantity * item.unitPrice);
        priceData.totalQty += item.quantity;
      });
    });
    
    // Calculate average delivery times (this would need delivery data)
    // For now, we'll use a placeholder
    
    // Format the response
    const itemsSupplied = Array.from(itemMap.values()).map(item => {
      const lastOrder = itemLastOrderMap.get(item.rawItem || item.name);
      const priceData = itemPriceMap.get(item.rawItem || item.name);
      const avgPrice = priceData ? priceData.totalPrice / priceData.totalQty : 0;
      
      return {
        _id: item.rawItem || item.name,
        name: item.name,
        sku: item.sku,
        category: item.category,
        totalQuantity: item.totalQuantity,
        totalValue: item.totalValue,
        orders: item.orders,
        lastOrder: lastOrder,
        avgPrice: avgPrice,
        avgDeliveryTime: 5, // Placeholder - would need delivery tracking
        deliveredPercentage: item.totalQuantity > 0 ? 
          Math.round((item.totalDelivered / item.totalQuantity) * 100) : 0
      };
    });
    
    // Sort by total value (highest first)
    itemsSupplied.sort((a, b) => b.totalValue - a.totalValue);
    
    res.json({
      success: true,
      itemsSupplied,
      stats: {
        totalItems: itemsSupplied.length,
        totalValue: itemsSupplied.reduce((sum, item) => sum + item.totalValue, 0),
        totalQuantity: itemsSupplied.reduce((sum, item) => sum + item.totalQuantity, 0)
      }
    });
    
  } catch (error) {
    console.error("Error fetching items supplied:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching items supplied"
    });
  }
});

// ✅ GET vendor performance metrics
router.get("/:id/performance", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }
    
    // Get all purchase orders for this vendor
    const purchaseOrders = await PurchaseOrder.find({ vendor: req.params.id })
      .select("status totalAmount items deliveries paymentStatus orderDate expectedDeliveryDate");
    
    // Calculate metrics
    const totalOrders = purchaseOrders.length;
    const completedOrders = purchaseOrders.filter(po => po.status === "COMPLETED").length;
    const cancelledOrders = purchaseOrders.filter(po => po.status === "CANCELLED").length;
    const pendingOrders = purchaseOrders.filter(po => 
      po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED"
    ).length;
    
    // Calculate on-time delivery (placeholder - would need actual vs expected dates)
    let onTimeDelivery = 85; // Placeholder
    if (totalOrders > 0) {
      const deliveredOrders = purchaseOrders.filter(po => 
        po.status === "COMPLETED" || po.status === "PARTIALLY_RECEIVED"
      );
      
      if (deliveredOrders.length > 0) {
        // Simple calculation: count orders with actual delivery before or on expected date
        const onTimeCount = deliveredOrders.filter(po => {
          if (!po.deliveries || po.deliveries.length === 0) return false;
          const lastDelivery = po.deliveries[0]; // Most recent delivery
          const deliveryDate = lastDelivery.deliveryDate || lastDelivery.createdAt;
          const expectedDate = po.expectedDeliveryDate || new Date(po.orderDate.getTime() + 7*24*60*60*1000); // Default 7 days
          return deliveryDate <= expectedDate;
        }).length;
        
        onTimeDelivery = Math.round((onTimeCount / deliveredOrders.length) * 100);
      }
    }
    
    // Calculate total spent
    const totalSpent = purchaseOrders
      .filter(po => po.status === "COMPLETED")
      .reduce((sum, po) => sum + po.totalAmount, 0);
    
    // Calculate average order value
    const avgOrderValue = totalOrders > 0 ? totalSpent / totalOrders : 0;
    
    // Calculate payment on-time rate
    let paymentOnTime = 90; // Placeholder
    const paidOrders = purchaseOrders.filter(po => po.paymentStatus === "COMPLETED");
    if (paidOrders.length > 0) {
      // Simple calculation based on payment dates
      const onTimePayments = paidOrders.filter(po => {
        if (!po.payments || po.payments.length === 0) return false;
        const lastPayment = po.payments[po.payments.length - 1]; // Last payment
        const paymentDate = lastPayment.date || lastPayment.createdAt;
        const dueDate = new Date(po.orderDate.getTime() + 30*24*60*60*1000); // 30 days from order
        return paymentDate <= dueDate;
      }).length;
      
      paymentOnTime = Math.round((onTimePayments / paidOrders.length) * 100);
    }
    
    // Get pending amount
    const pendingOrdersList = purchaseOrders.filter(po => 
      po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED"
    );
    const pendingAmount = pendingOrdersList.reduce((sum, po) => sum + po.totalAmount, 0);
    
    // Get vendor's rating from vendor document or calculate from feedback
    const qualityRating = vendor.rating || 4.2;
    
    // Calculate recent trends (last 3 months vs previous 3 months)
    const now = new Date();
    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    
    const recentOrders = purchaseOrders.filter(po => 
      po.orderDate >= threeMonthsAgo
    );
    const previousOrders = purchaseOrders.filter(po => 
      po.orderDate >= sixMonthsAgo && po.orderDate < threeMonthsAgo
    );
    
    const recentSpent = recentOrders
      .filter(po => po.status === "COMPLETED")
      .reduce((sum, po) => sum + po.totalAmount, 0);
    
    const previousSpent = previousOrders
      .filter(po => po.status === "COMPLETED")
      .reduce((sum, po) => sum + po.totalAmount, 0);
    
    const monthlyGrowth = previousSpent > 0 ? 
      Math.round(((recentSpent - previousSpent) / previousSpent) * 100) : 100;
    
    const orderFrequency = totalOrders > 0 ? 
      Math.round((totalOrders / 12) * 10) / 10 : 0; // Orders per month
    
    // Calculate response time (placeholder - would need communication tracking)
    const responseTime = 24; // hours average
    
    res.json({
      success: true,
      performance: {
        totalOrders,
        completedOrders,
        cancelledOrders,
        pendingOrders,
        onTimeDelivery,
        qualityRating,
        totalSpent,
        avgOrderValue,
        paymentOnTime,
        pendingAmount,
        monthlyGrowth,
        orderFrequency,
        responseTime
      }
    });
    
  } catch (error) {
    console.error("Error fetching vendor performance:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor performance"
    });
  }
});




module.exports = router;