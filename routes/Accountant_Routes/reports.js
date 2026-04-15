// routes/Accountant_Routes/reports.js
// Complete Financial Reports Routes

const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Customer = require("../../models/Customer_Models/Customer");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const {
  Expense, Invoice, BankTransaction, TaxFiling,
} = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// ── Accounts Receivable Aging Report ──
router.get("/receivables-aging", async (req, res) => {
  try {
    const today = new Date();
    const requests = await CustomerRequest.find({
      "quotations.0": { $exists: true },
    })
      .populate("customerId", "name email phone")
      .select("quotations totalPaidAmount customerId requestId createdAt")
      .lean();

    const aging = { current: [], days_1_30: [], days_31_60: [], days_61_90: [], days_90_plus: [] };
    let totalOutstanding = 0;

    requests.forEach((r) => {
      const q = r.quotations?.[0];
      if (!q?.grandTotal) return;
      const outstanding = (q.grandTotal || 0) - (r.totalPaidAmount || 0);
      if (outstanding <= 0) return;

      const daysSince = Math.floor((today - new Date(r.createdAt)) / (1000 * 60 * 60 * 24));
      const entry = {
        requestId: r.requestId,
        customer: r.customerId,
        total: q.grandTotal,
        paid: r.totalPaidAmount || 0,
        outstanding,
        daysSince,
        createdAt: r.createdAt,
      };

      totalOutstanding += outstanding;

      if (daysSince <= 0) aging.current.push(entry);
      else if (daysSince <= 30) aging.days_1_30.push(entry);
      else if (daysSince <= 60) aging.days_31_60.push(entry);
      else if (daysSince <= 90) aging.days_61_90.push(entry);
      else aging.days_90_plus.push(entry);
    });

    res.json({
      success: true,
      report: {
        aging,
        summary: {
          totalOutstanding,
          current: aging.current.reduce((s, e) => s + e.outstanding, 0),
          days_1_30: aging.days_1_30.reduce((s, e) => s + e.outstanding, 0),
          days_31_60: aging.days_31_60.reduce((s, e) => s + e.outstanding, 0),
          days_61_90: aging.days_61_90.reduce((s, e) => s + e.outstanding, 0),
          days_90_plus: aging.days_90_plus.reduce((s, e) => s + e.outstanding, 0),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating aging report" });
  }
});

// ── Accounts Payable Aging Report ──
router.get("/payables-aging", async (req, res) => {
  try {
    const today = new Date();
    const pos = await PurchaseOrder.find({
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] },
    })
      .populate("vendor", "companyName contactPerson email")
      .select("poNumber totalAmount payments vendor orderDate")
      .lean();

    const aging = { current: [], days_1_30: [], days_31_60: [], days_61_90: [], days_90_plus: [] };

    pos.forEach((po) => {
      const paid = po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
      const outstanding = (po.totalAmount || 0) - paid;
      if (outstanding <= 0) return;

      const daysSince = Math.floor((today - new Date(po.orderDate)) / (1000 * 60 * 60 * 24));
      const entry = {
        poNumber: po.poNumber,
        vendor: po.vendor,
        total: po.totalAmount,
        paid,
        outstanding,
        daysSince,
        orderDate: po.orderDate,
      };

      if (daysSince <= 0) aging.current.push(entry);
      else if (daysSince <= 30) aging.days_1_30.push(entry);
      else if (daysSince <= 60) aging.days_31_60.push(entry);
      else if (daysSince <= 90) aging.days_61_90.push(entry);
      else aging.days_90_plus.push(entry);
    });

    const totalOutstanding = [...aging.current, ...aging.days_1_30, ...aging.days_31_60, ...aging.days_61_90, ...aging.days_90_plus]
      .reduce((s, e) => s + e.outstanding, 0);

    res.json({
      success: true,
      report: {
        aging,
        summary: {
          totalOutstanding,
          current: aging.current.reduce((s, e) => s + e.outstanding, 0),
          days_1_30: aging.days_1_30.reduce((s, e) => s + e.outstanding, 0),
          days_31_60: aging.days_31_60.reduce((s, e) => s + e.outstanding, 0),
          days_61_90: aging.days_61_90.reduce((s, e) => s + e.outstanding, 0),
          days_90_plus: aging.days_90_plus.reduce((s, e) => s + e.outstanding, 0),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating payables aging report" });
  }
});

// ── GST Report ──
router.get("/gst", async (req, res) => {
  try {
    const { startDate, endDate, type = "summary" } = req.query;
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    // Output GST (Sales)
    const invoices = await Invoice.find(
      dateFilter.invoiceDate ? { invoiceDate: dateFilter } : {}
    )
      .select("invoiceNumber invoiceDate customerName taxBreakdown grandTotal items")
      .lean();

    const outputGST = {
      totalTaxableValue: invoices.reduce((s, i) => s + (i.subtotal || i.grandTotal || 0), 0),
      totalCGST: invoices.reduce((s, i) => s + (i.taxBreakdown?.cgst || 0), 0),
      totalSGST: invoices.reduce((s, i) => s + (i.taxBreakdown?.sgst || 0), 0),
      totalIGST: invoices.reduce((s, i) => s + (i.taxBreakdown?.igst || 0), 0),
      totalTax: invoices.reduce((s, i) => s + (i.taxBreakdown?.totalTax || 0), 0),
      invoiceCount: invoices.length,
    };

    // Input GST (Purchases)
    const expenses = await Expense.find({
      gstApplicable: true,
      ...(dateFilter.$gte ? { createdAt: dateFilter } : {}),
    })
      .select("expenseId description gstDetails totalAmount vendorName")
      .lean();

    const inputGST = {
      totalTaxableValue: expenses.reduce((s, e) => s + (e.totalAmount || 0), 0),
      totalCGST: expenses.reduce((s, e) => s + (e.gstDetails?.cgst || 0), 0),
      totalSGST: expenses.reduce((s, e) => s + (e.gstDetails?.sgst || 0), 0),
      totalIGST: expenses.reduce((s, e) => s + (e.gstDetails?.igst || 0), 0),
      totalTax: expenses.reduce((s, e) => {
        const g = e.gstDetails || {};
        return s + (g.cgst || 0) + (g.sgst || 0) + (g.igst || 0);
      }, 0),
      expenseCount: expenses.length,
    };

    const netGSTPayable = outputGST.totalTax - inputGST.totalTax;

    res.json({
      success: true,
      gstReport: {
        outputGST,
        inputGST,
        netGSTPayable,
        inputTaxCredit: inputGST.totalTax,
        invoices: type === "detailed" ? invoices : undefined,
        expenses: type === "detailed" ? expenses : undefined,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating GST report" });
  }
});

// ── TDS Report ──
router.get("/tds", async (req, res) => {
  try {
    const { financialYear } = req.query;
    const expenses = await Expense.find({
      tdsApplicable: true,
      ...(financialYear ? { financialYear } : {}),
    })
      .select("expenseId description vendorName tdsDetails totalAmount createdAt")
      .lean();

    const summary = {
      totalDeductions: expenses.reduce((s, e) => s + (e.tdsDetails?.tdsAmount || 0), 0),
      totalTransactions: expenses.length,
      bySections: {},
    };

    expenses.forEach((e) => {
      const section = e.tdsDetails?.tdsSection || "Other";
      if (!summary.bySections[section]) {
        summary.bySections[section] = { count: 0, totalAmount: 0, totalTDS: 0 };
      }
      summary.bySections[section].count++;
      summary.bySections[section].totalAmount += e.totalAmount || 0;
      summary.bySections[section].totalTDS += e.tdsDetails?.tdsAmount || 0;
    });

    res.json({ success: true, tdsReport: { expenses, summary } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating TDS report" });
  }
});

// ── Payroll Cost Report ──
router.get("/payroll-cost", async (req, res) => {
  try {
    const { year } = req.query;
    const currentYear = parseInt(year) || new Date().getFullYear();

    const payrollRuns = await Payroll.find({ year: currentYear })
      .sort({ month: 1 })
      .lean();

    const monthlyCost = payrollRuns.map((r) => ({
      month: r.payPeriod,
      totalGross: r.totalGross || 0,
      totalDeductions: r.totalDeductions || 0,
      totalNetPay: r.totalNetPay || 0,
      totalPF: r.totalPF || 0,
      totalESIC: r.totalESIC || 0,
      employees: r.totalEmployees || 0,
      employerCost: (r.totalGross || 0) + (r.totalPF || 0) + (r.totalESIC || 0),
    }));

    const annualSummary = {
      totalGross: monthlyCost.reduce((s, m) => s + m.totalGross, 0),
      totalNet: monthlyCost.reduce((s, m) => s + m.totalNetPay, 0),
      totalPF: monthlyCost.reduce((s, m) => s + m.totalPF, 0),
      totalESIC: monthlyCost.reduce((s, m) => s + m.totalESIC, 0),
      totalEmployerCost: monthlyCost.reduce((s, m) => s + m.employerCost, 0),
    };

    res.json({ success: true, payrollCostReport: { monthlyCost, annualSummary } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating payroll report" });
  }
});

// ── Revenue by Customer Report ──
router.get("/revenue-by-customer", async (req, res) => {
  try {
    const requests = await CustomerRequest.find({
      "quotations.0": { $exists: true },
    })
      .populate("customerId", "name email phone")
      .select("quotations totalPaidAmount customerId")
      .lean();

    const customerRevenue = {};
    requests.forEach((r) => {
      const custId = r.customerId?._id?.toString();
      if (!custId) return;
      if (!customerRevenue[custId]) {
        customerRevenue[custId] = {
          customer: r.customerId,
          totalOrders: 0,
          totalRevenue: 0,
          totalPaid: 0,
          totalOutstanding: 0,
        };
      }
      const q = r.quotations?.[0];
      customerRevenue[custId].totalOrders++;
      customerRevenue[custId].totalRevenue += q?.grandTotal || 0;
      customerRevenue[custId].totalPaid += r.totalPaidAmount || 0;
      customerRevenue[custId].totalOutstanding += (q?.grandTotal || 0) - (r.totalPaidAmount || 0);
    });

    const report = Object.values(customerRevenue).sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.json({ success: true, revenueByCustomer: report });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating revenue report" });
  }
});

// ── Expense Summary Report ──
router.get("/expense-summary", async (req, res) => {
  try {
    const { startDate, endDate, financialYear } = req.query;
    let filter = { status: { $ne: "void" } };
    if (financialYear) filter.financialYear = financialYear;
    if (startDate && endDate) {
      filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const expenses = await Expense.find(filter)
      .select("category totalAmount paymentStatus createdAt vendorName")
      .lean();

    const byCategory = {};
    const byMonth = {};
    const byVendor = {};

    expenses.forEach((e) => {
      // By category
      if (!byCategory[e.category]) byCategory[e.category] = 0;
      byCategory[e.category] += e.totalAmount || 0;

      // By month
      const monthKey = new Date(e.createdAt).toLocaleString("en-IN", { month: "short", year: "numeric" });
      if (!byMonth[monthKey]) byMonth[monthKey] = 0;
      byMonth[monthKey] += e.totalAmount || 0;

      // By vendor
      const vendor = e.vendorName || "Direct/Other";
      if (!byVendor[vendor]) byVendor[vendor] = 0;
      byVendor[vendor] += e.totalAmount || 0;
    });

    res.json({
      success: true,
      expenseSummary: {
        total: expenses.reduce((s, e) => s + (e.totalAmount || 0), 0),
        count: expenses.length,
        byCategory,
        byMonth,
        byVendor: Object.entries(byVendor)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 20)
          .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {}),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error generating expense summary" });
  }
});

module.exports = router;
