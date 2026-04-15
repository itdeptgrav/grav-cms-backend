// routes/Accountant_Routes/invoices.js
// Complete Invoice Management Routes

const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { Invoice, AccountantSettings, ActivityLog } = require("../../models/Accountant_model/AccountantModels");
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// Helper: number to words for Indian currency
const numberToWords = (num) => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  if (num === 0) return "Zero Rupees Only";

  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " and " + convert(n % 100) : "");
    if (n < 100000) return convert(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + convert(n % 1000) : "");
    if (n < 10000000) return convert(Math.floor(n / 100000)) + " Lakh" + (n % 100000 ? " " + convert(n % 100000) : "");
    return convert(Math.floor(n / 10000000)) + " Crore" + (n % 10000000 ? " " + convert(n % 10000000) : "");
  };

  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  let words = convert(rupees) + " Rupees";
  if (paise > 0) words += " and " + convert(paise) + " Paise";
  return words + " Only";
};

// Helper: generate invoice number
const generateInvoiceNumber = async () => {
  const settings = await AccountantSettings.getSingleton();
  const prefix = settings.invoicePrefix || "INV";
  const nextNum = (settings.currentInvoiceNumber || 0) + 1;
  const fy = settings.currentFinancialYear || new Date().getFullYear().toString();
  settings.currentInvoiceNumber = nextNum;
  await settings.save();
  return `${prefix}/${fy}/${nextNum.toString().padStart(4, "0")}`;
};

// ── GET all invoices ──
router.get("/", async (req, res) => {
  try {
    const {
      page = 1, limit = 20, status, paymentStatus,
      startDate, endDate, search, customerId, sortBy = "createdAt", sortOrder = "desc",
    } = req.query;

    let filter = {};
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (customerId) filter.customerId = customerId;

    if (startDate || endDate) {
      filter.invoiceDate = {};
      if (startDate) filter.invoiceDate.$gte = new Date(startDate);
      if (endDate) filter.invoiceDate.$lte = new Date(endDate);
    }

    if (search) {
      filter.$or = [
        { invoiceNumber: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
        { requestId: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ [sortBy]: sortOrder === "asc" ? 1 : -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    // Summary
    const allInvoices = await Invoice.find(filter).select("grandTotal paymentStatus paidAmount balanceDue").lean();
    const summary = {
      totalInvoiced: allInvoices.reduce((s, i) => s + (i.grandTotal || 0), 0),
      totalCollected: allInvoices.reduce((s, i) => s + (i.paidAmount || 0), 0),
      totalOutstanding: allInvoices.reduce((s, i) => s + (i.balanceDue || 0), 0),
      overdue: allInvoices.filter((i) => i.paymentStatus === "overdue").length,
      count: total,
    };

    res.json({
      success: true,
      invoices,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
      summary,
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    res.status(500).json({ success: false, message: "Error fetching invoices" });
  }
});

// ── GET single invoice ──
router.get("/:id", async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate("customerId", "name email phone profile")
      .populate("createdBy", "name email")
      .lean();

    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });

    res.json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching invoice" });
  }
});

// ── CREATE invoice ──
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    data.invoiceNumber = await generateInvoiceNumber();
    data.createdBy = req.user.id;

    // Calculate totals
    let subtotal = 0;
    let totalTax = 0;
    let totalDiscount = 0;

    if (data.items && data.items.length > 0) {
      data.items.forEach((item) => {
        let itemTotal = item.quantity * item.unitPrice;
        let discount = 0;

        if (item.discount) {
          discount = item.discountType === "percentage"
            ? (itemTotal * item.discount) / 100
            : item.discount;
        }

        itemTotal -= discount;
        const tax = (itemTotal * (item.taxRate || 0)) / 100;

        item.taxAmount = parseFloat(tax.toFixed(2));
        item.totalPrice = parseFloat((itemTotal + tax).toFixed(2));

        subtotal += itemTotal;
        totalTax += tax;
        totalDiscount += discount;
      });
    }

    data.subtotal = parseFloat(subtotal.toFixed(2));
    data.discountTotal = parseFloat(totalDiscount.toFixed(2));
    data.taxBreakdown = {
      cgst: parseFloat((totalTax / 2).toFixed(2)),
      sgst: parseFloat((totalTax / 2).toFixed(2)),
      igst: 0,
      totalTax: parseFloat(totalTax.toFixed(2)),
    };

    const grandTotal = subtotal + totalTax;
    data.grandTotal = parseFloat(grandTotal.toFixed(2));
    data.roundOff = parseFloat((Math.round(grandTotal) - grandTotal).toFixed(2));
    data.balanceDue = data.grandTotal;
    data.amountInWords = numberToWords(Math.round(grandTotal));

    // Set financial year
    const invDate = new Date(data.invoiceDate || Date.now());
    const fy = invDate.getMonth() >= 3 ? invDate.getFullYear() : invDate.getFullYear() - 1;
    data.financialYear = `${fy}-${(fy + 1).toString().slice(2)}`;

    // Company details
    const settings = await AccountantSettings.getSingleton();
    data.companyDetails = {
      name: settings.companyName,
      gstin: settings.companyGSTIN,
      pan: settings.companyPAN,
      address: settings.companyAddress,
      phone: settings.companyPhone,
      email: settings.companyEmail,
    };

    if (settings.bankAccounts?.length > 0) {
      const defaultBank = settings.bankAccounts.find((b) => b.isDefault) || settings.bankAccounts[0];
      data.companyDetails.bankName = defaultBank.bankName;
      data.companyDetails.accountNumber = defaultBank.accountNumber;
      data.companyDetails.ifscCode = defaultBank.ifscCode;
      data.companyDetails.upiId = defaultBank.upiId;
    }

    data.termsAndConditions = data.termsAndConditions || settings.invoiceTerms || "";

    const invoice = await Invoice.create(data);

    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Created invoice",
      module: "invoice",
      entityType: "Invoice",
      entityId: invoice._id,
      details: `Created invoice ${invoice.invoiceNumber} for ₹${invoice.grandTotal}`,
    });

    res.status(201).json({ success: true, message: "Invoice created", invoice });
  } catch (error) {
    console.error("Error creating invoice:", error);
    res.status(500).json({ success: false, message: "Error creating invoice" });
  }
});

// ── UPDATE invoice ──
router.put("/:id", async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (invoice.status === "paid") {
      return res.status(400).json({ success: false, message: "Cannot edit paid invoice" });
    }

    const data = req.body;
    data.updatedBy = req.user.id;

    const updated = await Invoice.findByIdAndUpdate(req.params.id, data, { new: true });
    res.json({ success: true, message: "Invoice updated", invoice: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating invoice" });
  }
});

// ── RECORD payment against invoice ──
router.post("/:id/payment", async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });

    const { amount, paymentMethod, referenceNumber, paymentDate, notes } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Valid amount required" });
    }

    if (amount > invoice.balanceDue) {
      return res.status(400).json({ success: false, message: `Amount exceeds balance due (₹${invoice.balanceDue})` });
    }

    invoice.payments.push({
      amount,
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      paymentMethod,
      referenceNumber,
      notes,
      recordedBy: req.user.id,
    });

    invoice.paidAmount += amount;
    invoice.balanceDue = invoice.grandTotal - invoice.paidAmount;

    if (invoice.balanceDue <= 0) {
      invoice.paymentStatus = "paid";
      invoice.status = "paid";
    } else {
      invoice.paymentStatus = "partially_paid";
    }

    await invoice.save();

    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Recorded payment",
      module: "invoice",
      entityType: "Invoice",
      entityId: invoice._id,
      details: `Recorded ₹${amount} payment for invoice ${invoice.invoiceNumber}`,
    });

    res.json({ success: true, message: `Payment of ₹${amount} recorded`, invoice });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error recording payment" });
  }
});

// ── GENERATE invoice from customer request ──
router.post("/generate-from-request/:requestId", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.requestId)
      .populate("customerId", "name email phone profile")
      .lean();

    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const quotation = request.quotations?.[0];
    if (!quotation) return res.status(400).json({ success: false, message: "No quotation found for request" });

    // Build invoice items from quotation
    const items = (quotation.items || []).map((item) => ({
      itemName: item.itemName || item.itemCode || "Item",
      description: item.description || "",
      hsnCode: item.hsnCode || "",
      quantity: item.quantity || 1,
      unitPrice: item.unitPrice || 0,
      discount: item.discount || 0,
      discountType: item.discountType || "flat",
      taxRate: item.taxRate || 0,
      taxAmount: item.taxAmount || 0,
      totalPrice: item.totalPrice || 0,
    }));

    const customer = request.customerId;
    const invoiceData = {
      invoiceDate: new Date(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      customerId: customer._id,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      customerRequestId: request._id,
      requestId: request.requestId,
      quotationId: quotation._id,
      items,
    };

    // Use the create invoice logic (simulate req/res)
    req.body = invoiceData;

    // Inline create
    invoiceData.invoiceNumber = await generateInvoiceNumber();
    invoiceData.createdBy = req.user.id;

    let subtotal = 0, totalTax = 0;
    items.forEach((item) => {
      const itemTotal = item.quantity * item.unitPrice - (item.discount || 0);
      const tax = (itemTotal * (item.taxRate || 0)) / 100;
      item.taxAmount = parseFloat(tax.toFixed(2));
      item.totalPrice = parseFloat((itemTotal + tax).toFixed(2));
      subtotal += itemTotal;
      totalTax += tax;
    });

    invoiceData.subtotal = parseFloat(subtotal.toFixed(2));
    invoiceData.taxBreakdown = {
      cgst: parseFloat((totalTax / 2).toFixed(2)),
      sgst: parseFloat((totalTax / 2).toFixed(2)),
      igst: 0,
      totalTax: parseFloat(totalTax.toFixed(2)),
    };
    invoiceData.grandTotal = parseFloat((subtotal + totalTax).toFixed(2));
    invoiceData.balanceDue = invoiceData.grandTotal;
    invoiceData.amountInWords = numberToWords(Math.round(invoiceData.grandTotal));

    const invDate = new Date();
    const fy = invDate.getMonth() >= 3 ? invDate.getFullYear() : invDate.getFullYear() - 1;
    invoiceData.financialYear = `${fy}-${(fy + 1).toString().slice(2)}`;

    const invoice = await Invoice.create(invoiceData);

    res.status(201).json({ success: true, message: "Invoice generated from request", invoice });
  } catch (error) {
    console.error("Error generating invoice:", error);
    res.status(500).json({ success: false, message: "Error generating invoice" });
  }
});

// ── SEND invoice (mark as sent) ──
router.post("/:id/send", async (req, res) => {
  try {
    const invoice = await Invoice.findByIdAndUpdate(
      req.params.id,
      { status: "sent" },
      { new: true }
    );
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    res.json({ success: true, message: "Invoice marked as sent", invoice });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error sending invoice" });
  }
});

// ── CANCEL invoice ──
router.post("/:id/cancel", async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (invoice.paymentStatus === "paid") {
      return res.status(400).json({ success: false, message: "Cannot cancel paid invoice" });
    }

    invoice.status = "cancelled";
    invoice.paymentStatus = "cancelled";
    await invoice.save();

    res.json({ success: true, message: "Invoice cancelled" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error cancelling invoice" });
  }
});

// ── DELETE invoice ──
router.delete("/:id", async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (invoice.status !== "draft") {
      return res.status(400).json({ success: false, message: "Can only delete draft invoices" });
    }
    await invoice.deleteOne();
    res.json({ success: true, message: "Invoice deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting invoice" });
  }
});

module.exports = router;
