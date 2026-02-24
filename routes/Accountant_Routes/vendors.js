// routes/Accountant_Routes/vendors.js - UPDATED WITH CORRECT MIDDLEWARE

const express = require("express");
const router = express.Router();
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");

// Apply accountant auth middleware to all routes
router.use(AccountantAuthMiddlewaer.accountantAuth);

// ✅ GET all vendors with financial stats
router.get("/", async (req, res) => {
  try {
    const { search = "", status } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { contactPerson: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { gstNumber: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    if (status && status !== "all") {
      filter.status = status;
    }

    const vendors = await Vendor.find(filter)
      .select(
        "companyName contactPerson email phone gstNumber panNumber address status rating notes vendorType paymentTerms createdBy updatedBy createdAt",
      )
      .sort({ companyName: 1 });

    // Get financial statistics for each vendor
    const vendorsWithStats = await Promise.all(
      vendors.map(async (vendor) => {
        const purchaseOrders = await PurchaseOrder.find({
          vendor: vendor._id,
          status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
        });

        // Calculate financial stats
        let totalPayables = 0;
        let outstandingPayables = 0;
        let totalPaid = 0;
        let totalPOs = purchaseOrders.length;

        purchaseOrders.forEach((po) => {
          totalPayables += po.totalAmount || 0;

          // Calculate paid amount
          const poPaid =
            po.payments?.reduce(
              (sum, payment) => sum + (payment.amount || 0),
              0,
            ) || 0;
          totalPaid += poPaid;

          // Calculate outstanding
          outstandingPayables += (po.totalAmount || 0) - poPaid;
        });

        // Calculate 6-month expenses (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const recentPOs = await PurchaseOrder.find({
          vendor: vendor._id,
          orderDate: { $gte: sixMonthsAgo },
          status: { $in: ["PARTIALLY_RECEIVED", "COMPLETED"] },
        });

        const totalExpenses6Months = recentPOs.reduce((sum, po) => {
          const poPaid =
            po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
          return sum + poPaid;
        }, 0);

        return {
          id: vendor._id,
          vendorId: `VEN-${vendor._id.toString().substring(18, 24).toUpperCase()}`,
          name: vendor.companyName,
          contactPerson: vendor.contactPerson,
          email: vendor.email,
          phone: vendor.phone,
          company: vendor.companyName,
          type: vendor.vendorType || "Business",
          currency: "INR",
          totalPayables: parseFloat(totalPayables.toFixed(2)),
          outstandingPayables: parseFloat(outstandingPayables.toFixed(2)),
          unusedCredits: 0,
          paymentTerms: vendor.paymentTerms || "Net 30",
          gstin: vendor.gstNumber || "",
          pan: vendor.panNumber || "",
          status: vendor.status || "Active",
          portalStatus: "Disabled",
          createdDate: vendor.createdAt.toLocaleDateString("en-GB"),
          createdBy: "System",
          totalExpenses6Months: parseFloat(totalExpenses6Months.toFixed(2)),
          billingAddress: vendor.address || {
            street: "",
            city: "",
            state: "",
            pincode: "",
            country: "India",
          },
          totalPOs: totalPOs,
          totalPaid: parseFloat(totalPaid.toFixed(2)),
        };
      }),
    );

    // Calculate summary stats
    const totalVendors = vendorsWithStats.length;
    const totalPayables = vendorsWithStats.reduce(
      (sum, v) => sum + v.totalPayables,
      0,
    );
    const totalOutstanding = vendorsWithStats.reduce(
      (sum, v) => sum + v.outstandingPayables,
      0,
    );

    res.json({
      success: true,
      vendors: vendorsWithStats,
      stats: {
        total: totalVendors,
        totalPayables: parseFloat(totalPayables.toFixed(2)),
        totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
      },
    });
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors",
    });
  }
});

// ✅ GET vendor by ID with detailed information
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select(
      "companyName contactPerson email phone gstNumber panNumber address status rating notes vendorType paymentTerms bankDetails primaryProducts createdBy updatedBy createdAt",
    );

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Get purchase orders for this vendor
    const purchaseOrders = await PurchaseOrder.find({
      vendor: vendor._id,
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
    })
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status totalReceived totalPending paymentStatus payments",
      )
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    // Calculate financial stats
    let totalPayables = 0;
    let outstandingPayables = 0;
    let totalPaid = 0;
    let recentTransactions = [];

    purchaseOrders.forEach((po) => {
      totalPayables += po.totalAmount || 0;

      const poPaid =
        po.payments?.reduce((sum, payment) => sum + (payment.amount || 0), 0) ||
        0;
      totalPaid += poPaid;
      outstandingPayables += (po.totalAmount || 0) - poPaid;

      // Add payment transactions
      if (po.payments && po.payments.length > 0) {
        po.payments.forEach((payment) => {
          recentTransactions.push({
            id: payment._id,
            type: "PAYMENT",
            date: payment.paymentDate || payment.createdAt,
            poNumber: po.poNumber,
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            referenceNumber: payment.referenceNumber,
            notes: payment.notes,
            recordedBy: payment.recordedBy?.name || "System",
            status: "COMPLETED",
          });
        });
      }

      // Add purchase order transactions
      recentTransactions.push({
        id: po._id,
        type: "PURCHASE_ORDER",
        date: po.orderDate,
        poNumber: po.poNumber,
        amount: po.totalAmount,
        status: po.status,
        paymentStatus: po.paymentStatus,
      });
    });

    // Sort transactions by date (newest first)
    recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate 6-month expenses
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentPOs = await PurchaseOrder.find({
      vendor: vendor._id,
      orderDate: { $gte: sixMonthsAgo },
      status: { $in: ["PARTIALLY_RECEIVED", "COMPLETED"] },
    });

    const totalExpenses6Months = recentPOs.reduce((sum, po) => {
      const poPaid = po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
      return sum + poPaid;
    }, 0);

    const vendorData = {
      id: vendor._id,
      vendorId: `VEN-${vendor._id.toString().substring(18, 24).toUpperCase()}`,
      name: vendor.companyName,
      contactPerson: vendor.contactPerson,
      email: vendor.email,
      phone: vendor.phone,
      company: vendor.companyName,
      type: vendor.vendorType || "Business",
      currency: "INR",
      totalPayables: parseFloat(totalPayables.toFixed(2)),
      outstandingPayables: parseFloat(outstandingPayables.toFixed(2)),
      unusedCredits: 0,
      paymentTerms: vendor.paymentTerms || "Net 30",
      gstin: vendor.gstNumber || "",
      pan: vendor.panNumber || "",
      status: vendor.status || "Active",
      portalStatus: "Disabled",
      createdDate: vendor.createdAt.toLocaleDateString("en-GB"),
      createdBy: vendor.createdBy ? "User" : "System",
      totalExpenses6Months: parseFloat(totalExpenses6Months.toFixed(2)),
      billingAddress: vendor.address || {
        street: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      bankDetails: vendor.bankDetails || {},
      primaryProducts: vendor.primaryProducts || [],
      rating: vendor.rating || 3,
      notes: vendor.notes || "",
      purchaseOrders: purchaseOrders.map((po) => ({
        id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        totalAmount: po.totalAmount,
        status: po.status,
        totalReceived: po.totalReceived,
        totalPending: po.totalPending,
        paymentStatus: po.paymentStatus,
        totalPaid:
          po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0,
        remainingAmount:
          po.totalAmount -
          (po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0),
      })),
      recentTransactions: recentTransactions.slice(0, 50),
      stats: {
        totalOrders: purchaseOrders.length,
        completedOrders: purchaseOrders.filter(
          (po) => po.status === "COMPLETED",
        ).length,
        pendingOrders: purchaseOrders.filter(
          (po) => po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED",
        ).length,
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        avgPaymentDays: 30,
      },
    };

    res.json({
      success: true,
      vendor: vendorData,
    });
  } catch (error) {
    console.error("Error fetching vendor details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor details",
    });
  }
});

// ✅ GET vendor purchase orders
router.get("/:id/purchase-orders", async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;

    let filter = { vendor: req.params.id };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select(
        "poNumber orderDate expectedDeliveryDate totalAmount status paymentStatus totalReceived totalPending items payments",
      )
      .populate("items.rawItem", "name sku unit")
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    res.json({
      success: true,
      purchaseOrders: purchaseOrders.map((po) => ({
        id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        totalAmount: po.totalAmount,
        status: po.status,
        paymentStatus: po.paymentStatus,
        totalReceived: po.totalReceived,
        totalPending: po.totalPending,
        items: po.items.map((item) => ({
          id: item._id,
          itemName: item.itemName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          receivedQuantity: item.receivedQuantity,
          pendingQuantity: item.pendingQuantity,
        })),
        payments: po.payments || [],
        totalPaid:
          po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0,
        remainingAmount:
          po.totalAmount -
          (po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0),
      })),
    });
  } catch (error) {
    console.error("Error fetching vendor purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase orders",
    });
  }
});

// ✅ GET vendor transactions (payments + purchase orders)
router.get("/:id/transactions", async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;

    // Get all purchase orders for vendor
    const purchaseOrders = await PurchaseOrder.find({ vendor: req.params.id })
      .select("poNumber orderDate totalAmount status paymentStatus payments")
      .populate("payments.recordedBy", "name email")
      .sort({ orderDate: -1 });

    let transactions = [];

    purchaseOrders.forEach((po) => {
      // Add purchase order transaction
      transactions.push({
        id: po._id,
        type: "PURCHASE_ORDER",
        date: po.orderDate,
        poNumber: po.poNumber,
        description: `Purchase Order ${po.poNumber}`,
        amount: po.totalAmount,
        status: po.status,
        paymentStatus: po.paymentStatus,
        category: "PURCHASE",
        reference: po.poNumber,
      });

      // Add payment transactions
      if (po.payments && po.payments.length > 0) {
        po.payments.forEach((payment) => {
          transactions.push({
            id: payment._id,
            type: "PAYMENT",
            date: payment.paymentDate || payment.createdAt,
            poNumber: po.poNumber,
            description: `Payment for PO ${po.poNumber}`,
            amount: -payment.amount,
            paymentMethod: payment.paymentMethod,
            referenceNumber: payment.referenceNumber,
            notes: payment.notes,
            recordedBy: payment.recordedBy?.name || "System",
            status: "COMPLETED",
            category: "PAYMENT",
            reference:
              payment.referenceNumber ||
              `PAY-${payment._id.toString().substring(18, 24).toUpperCase()}`,
          });
        });
      }
    });

    // Apply filters
    if (type && type !== "all") {
      transactions = transactions.filter((t) => t.type === type);
    }

    if (startDate) {
      const start = new Date(startDate);
      transactions = transactions.filter((t) => new Date(t.date) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      transactions = transactions.filter((t) => new Date(t.date) <= end);
    }

    // Sort by date (newest first)
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate summary
    const totalPurchases = transactions
      .filter((t) => t.type === "PURCHASE_ORDER")
      .reduce((sum, t) => sum + t.amount, 0);

    const totalPayments = transactions
      .filter((t) => t.type === "PAYMENT")
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const balance = totalPurchases - totalPayments;

    res.json({
      success: true,
      transactions,
      summary: {
        totalPurchases: parseFloat(totalPurchases.toFixed(2)),
        totalPayments: parseFloat(totalPayments.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        transactionCount: transactions.length,
      },
    });
  } catch (error) {
    console.error("Error fetching vendor transactions:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching transactions",
    });
  }
});

// ✅ RECORD PAYMENT for vendor purchase order
router.post("/:id/payment", async (req, res) => {
  try {
    const {
      purchaseOrderId,
      amount,
      paymentMethod,
      referenceNumber,
      paymentDate,
      notes,
    } = req.body;

    // Validation
    if (!purchaseOrderId) {
      return res.status(400).json({
        success: false,
        message: "Purchase Order ID is required",
      });
    }

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

    // Verify purchase order belongs to vendor
    const purchaseOrder = await PurchaseOrder.findOne({
      _id: purchaseOrderId,
      vendor: req.params.id,
    });

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found for this vendor",
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

    // Get updated purchase order with populated data
    const updatedPO = await PurchaseOrder.findById(purchaseOrderId).populate(
      "payments.recordedBy",
      "name email",
    );

    const latestPayment = updatedPO.payments[0];

    res.json({
      success: true,
      message: `Payment of ₹${amount} recorded successfully`,
      payment: latestPayment,
      purchaseOrder: {
        id: updatedPO._id,
        poNumber: updatedPO.poNumber,
        totalAmount: updatedPO.totalAmount,
        paymentStatus: updatedPO.paymentStatus,
        totalPaid: newTotalPaid,
        remainingAmount: updatedPO.totalAmount - newTotalPaid,
      },
    });
  } catch (error) {
    console.error("Error recording payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error while recording payment",
    });
  }
});

// ✅ UPDATE vendor payment status
router.patch("/:id/purchase-orders/:poId/payment-status", async (req, res) => {
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

    // Verify purchase order belongs to vendor
    const purchaseOrder = await PurchaseOrder.findOne({
      _id: req.params.poId,
      vendor: req.params.id,
    });

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
      purchaseOrder: {
        id: purchaseOrder._id,
        poNumber: purchaseOrder.poNumber,
        paymentStatus: purchaseOrder.paymentStatus,
      },
    });
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating payment status",
    });
  }
});

// ✅ GET vendor payment history
router.get("/:id/payments", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const purchaseOrders = await PurchaseOrder.find({
      vendor: req.params.id,
      "payments.0": { $exists: true },
    })
      .select("poNumber totalAmount payments")
      .populate("payments.recordedBy", "name email");

    let allPayments = [];

    purchaseOrders.forEach((po) => {
      po.payments.forEach((payment) => {
        allPayments.push({
          id: payment._id,
          poNumber: po.poNumber,
          date: payment.paymentDate || payment.createdAt,
          amount: payment.amount,
          paymentMethod: payment.paymentMethod,
          referenceNumber: payment.referenceNumber,
          notes: payment.notes,
          recordedBy: payment.recordedBy?.name || "System",
          status: "COMPLETED",
          poTotalAmount: po.totalAmount,
        });
      });
    });

    // Apply date filters
    if (startDate) {
      const start = new Date(startDate);
      allPayments = allPayments.filter((p) => new Date(p.date) >= start);
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      allPayments = allPayments.filter((p) => new Date(p.date) <= end);
    }

    // Sort by date (newest first)
    allPayments.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals
    const totalPayments = allPayments.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      success: true,
      payments: allPayments,
      summary: {
        totalPayments: parseFloat(totalPayments.toFixed(2)),
        paymentCount: allPayments.length,
        avgPayment:
          allPayments.length > 0
            ? parseFloat((totalPayments / allPayments.length).toFixed(2))
            : 0,
      },
    });
  } catch (error) {
    console.error("Error fetching vendor payments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching payments",
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
      address,
      gstNumber,
      panNumber,
      paymentTerms,
      bankDetails,
      primaryProducts,
      notes,
    } = req.body;

    // Basic validation
    if (!companyName) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Check if vendor already exists
    const existingVendor = await Vendor.findOne({
      $or: [
        { companyName: { $regex: new RegExp(`^${companyName}$`, "i") } },
        { email: { $regex: new RegExp(`^${email}$`, "i") } },
      ],
    });

    if (existingVendor) {
      return res.status(400).json({
        success: false,
        message: "Vendor with this name or email already exists",
      });
    }

    // Create vendor
    const vendor = new Vendor({
      companyName,
      vendorType: vendorType || "Raw Material Supplier",
      contactPerson,
      email,
      phone,
      address: address || {
        street: "",
        city: "",
        state: "",
        pincode: "",
        country: "India",
      },
      gstNumber,
      panNumber,
      paymentTerms: paymentTerms || "Net 30",
      bankDetails: bankDetails || {},
      primaryProducts: primaryProducts || [],
      notes,
      status: "Active",
      rating: 3,
      createdBy: req.user.id,
    });

    await vendor.save();

    res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      vendor: {
        id: vendor._id,
        companyName: vendor.companyName,
        email: vendor.email,
        phone: vendor.phone,
        gstNumber: vendor.gstNumber,
        status: vendor.status,
      },
    });
  } catch (error) {
    console.error("Error creating vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating vendor",
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
      address,
      gstNumber,
      panNumber,
      paymentTerms,
      bankDetails,
      primaryProducts,
      status,
      notes,
    } = req.body;

    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Update fields
    if (companyName) vendor.companyName = companyName;
    if (vendorType) vendor.vendorType = vendorType;
    if (contactPerson !== undefined) vendor.contactPerson = contactPerson;
    if (email) vendor.email = email;
    if (phone !== undefined) vendor.phone = phone;
    if (address) vendor.address = address;
    if (gstNumber !== undefined) vendor.gstNumber = gstNumber;
    if (panNumber !== undefined) vendor.panNumber = panNumber;
    if (paymentTerms !== undefined) vendor.paymentTerms = paymentTerms;
    if (bankDetails !== undefined) vendor.bankDetails = bankDetails;
    if (primaryProducts !== undefined) vendor.primaryProducts = primaryProducts;
    if (status) vendor.status = status;
    if (notes !== undefined) vendor.notes = notes;

    vendor.updatedBy = req.user.id;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor updated successfully",
      vendor: {
        id: vendor._id,
        companyName: vendor.companyName,
        email: vendor.email,
        phone: vendor.phone,
        status: vendor.status,
      },
    });
  } catch (error) {
    console.error("Error updating vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating vendor",
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
        message: "Vendor not found",
      });
    }

    // Check if vendor has any purchase orders
    const purchaseOrders = await PurchaseOrder.find({ vendor: vendor._id });

    if (purchaseOrders.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete vendor with existing purchase orders. Mark as inactive instead.",
      });
    }

    await vendor.deleteOne();

    res.json({
      success: true,
      message: "Vendor deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting vendor",
    });
  }
});

module.exports = router;
