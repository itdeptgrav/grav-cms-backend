// routes/Accountant_Routes/dashboard.js
// Complete Dashboard & Overview Routes

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Customer = require("../../models/Customer_Models/Customer");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Employee = require("../../models/Employee");
const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const {
  Expense,
  Invoice,
  BankTransaction,
  Budget,
  TaxFiling,
  ActivityLog,
  AccountantSettings,
} = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// ═══════════════════════════════════════════════════════════════
// GET /api/accountant/dashboard - Main Dashboard Overview
// ═══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const startOfYear = new Date(today.getFullYear(), 3, 1); // April 1 FY start
    if (today.getMonth() < 3) startOfYear.setFullYear(today.getFullYear() - 1);

    // ── Revenue from customer requests ──
    const customerRequests = await CustomerRequest.find({
      createdAt: { $gte: startOfYear },
    })
      .select("quotations totalPaidAmount status createdAt")
      .lean();

    let totalRevenue = 0;
    let totalReceivables = 0;
    let monthlyRevenue = 0;

    customerRequests.forEach((req) => {
      if (req.quotations && req.quotations.length > 0) {
        const q = req.quotations[0];
        if (q.grandTotal) {
          totalRevenue += q.grandTotal;
          const paid = req.totalPaidAmount || 0;
          totalReceivables += q.grandTotal - paid;

          if (new Date(req.createdAt) >= startOfMonth) {
            monthlyRevenue += q.grandTotal;
          }
        }
      }
    });

    // ── Vendor payables ──
    const purchaseOrders = await PurchaseOrder.find({
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] },
    })
      .select("totalAmount payments orderDate")
      .lean();

    let totalPayables = 0;
    let totalVendorPaid = 0;

    purchaseOrders.forEach((po) => {
      totalPayables += po.totalAmount || 0;
      const poPaid = po.payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      totalVendorPaid += poPaid;
    });

    const outstandingPayables = totalPayables - totalVendorPaid;

    // ── Expenses ──
    const expenses = await Expense.find({
      createdAt: { $gte: startOfYear },
      status: { $ne: "void" },
    })
      .select("totalAmount category createdAt paymentStatus")
      .lean();

    const totalExpenses = expenses.reduce((sum, e) => sum + (e.totalAmount || 0), 0);
    const monthlyExpenses = expenses
      .filter((e) => new Date(e.createdAt) >= startOfMonth)
      .reduce((sum, e) => sum + (e.totalAmount || 0), 0);

    // ── Expense breakdown by category ──
    const expenseByCategory = {};
    expenses.forEach((e) => {
      if (!expenseByCategory[e.category]) expenseByCategory[e.category] = 0;
      expenseByCategory[e.category] += e.totalAmount || 0;
    });

    // ── Payroll summary ──
    const latestPayroll = await Payroll.findOne().sort({ year: -1, month: -1 }).lean();
    let payrollSummary = { totalNetPay: 0, totalEmployees: 0, totalGross: 0 };
    if (latestPayroll) {
      payrollSummary = {
        totalNetPay: latestPayroll.totalNetPay || 0,
        totalEmployees: latestPayroll.totalEmployees || 0,
        totalGross: latestPayroll.totalGross || 0,
        month: latestPayroll.payPeriod,
        status: latestPayroll.status,
      };
    }

    // ── Invoices summary ──
    const invoices = await Invoice.find({ createdAt: { $gte: startOfYear } })
      .select("grandTotal paymentStatus paidAmount status")
      .lean();

    const invoiceSummary = {
      total: invoices.length,
      totalAmount: invoices.reduce((sum, i) => sum + (i.grandTotal || 0), 0),
      paid: invoices.filter((i) => i.paymentStatus === "paid").length,
      unpaid: invoices.filter((i) => ["unpaid", "overdue"].includes(i.paymentStatus)).length,
      overdue: invoices.filter((i) => i.paymentStatus === "overdue").length,
    };

    // ── Pending verifications ──
    const pendingPaymentVerifications = await CustomerRequest.countDocuments({
      "quotations.paymentSubmissions.status": "pending",
    });

    // ── Tax obligations ──
    const upcomingTaxes = await TaxFiling.find({
      status: { $in: ["upcoming", "pending"] },
      dueDate: { $gte: today },
    })
      .sort({ dueDate: 1 })
      .limit(5)
      .lean();

    // ── Monthly revenue trend (last 6 months) ──
    const revenueTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
      const monthLabel = monthStart.toLocaleString("en-IN", { month: "short", year: "numeric" });

      const monthRevenue = customerRequests
        .filter((r) => {
          const d = new Date(r.createdAt);
          return d >= monthStart && d <= monthEnd;
        })
        .reduce((sum, r) => {
          const q = r.quotations?.[0];
          return sum + (q?.grandTotal || 0);
        }, 0);

      const monthExp = expenses
        .filter((e) => {
          const d = new Date(e.createdAt);
          return d >= monthStart && d <= monthEnd;
        })
        .reduce((sum, e) => sum + (e.totalAmount || 0), 0);

      revenueTrend.push({
        month: monthLabel,
        revenue: parseFloat(monthRevenue.toFixed(2)),
        expenses: parseFloat(monthExp.toFixed(2)),
        profit: parseFloat((monthRevenue - monthExp).toFixed(2)),
      });
    }

    // ── Cash flow ──
    const cashFlow = {
      inflow: totalRevenue,
      outflow: totalExpenses + totalVendorPaid + (payrollSummary.totalNetPay || 0),
      net: totalRevenue - (totalExpenses + totalVendorPaid + (payrollSummary.totalNetPay || 0)),
    };

    // ── Budget status ──
    const activeBudget = await Budget.findOne({ status: "active" }).sort({ createdAt: -1 }).lean();

    // ── Recent activity ──
    const recentActivity = await ActivityLog.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("accountantId", "name")
      .lean();

    // ── Counts ──
    const totalCustomers = await Customer.countDocuments();
    const totalVendors = await Vendor.countDocuments({ status: "Active" });
    const totalEmployees = await Employee.countDocuments({ isActive: true });

    res.json({
      success: true,
      dashboard: {
        financialSummary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          monthlyRevenue: parseFloat(monthlyRevenue.toFixed(2)),
          totalReceivables: parseFloat(totalReceivables.toFixed(2)),
          outstandingPayables: parseFloat(outstandingPayables.toFixed(2)),
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),
          monthlyExpenses: parseFloat(monthlyExpenses.toFixed(2)),
          netProfit: parseFloat((totalRevenue - totalExpenses - totalVendorPaid).toFixed(2)),
          cashFlow,
        },
        expenseByCategory,
        payrollSummary,
        invoiceSummary,
        pendingPaymentVerifications,
        upcomingTaxes,
        revenueTrend,
        activeBudget: activeBudget
          ? {
              name: activeBudget.name,
              totalAllocated: activeBudget.totalAllocated,
              totalSpent: activeBudget.totalSpent,
              utilization:
                activeBudget.totalAllocated > 0
                  ? parseFloat(((activeBudget.totalSpent / activeBudget.totalAllocated) * 100).toFixed(1))
                  : 0,
            }
          : null,
        counts: { totalCustomers, totalVendors, totalEmployees },
        recentActivity,
      },
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ success: false, message: "Error loading dashboard" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/accountant/dashboard/profit-loss - P&L Statement
// ═══════════════════════════════════════════════════════════════
router.get("/profit-loss", async (req, res) => {
  try {
    const { startDate, endDate, financialYear } = req.query;

    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = { $gte: new Date(startDate), $lte: new Date(endDate) };
    } else {
      const today = new Date();
      const fyStart = new Date(today.getFullYear(), 3, 1);
      if (today.getMonth() < 3) fyStart.setFullYear(today.getFullYear() - 1);
      dateFilter = { $gte: fyStart, $lte: today };
    }

    // Revenue
    const requests = await CustomerRequest.find({ createdAt: dateFilter })
      .select("quotations totalPaidAmount")
      .lean();

    let salesRevenue = 0;
    requests.forEach((r) => {
      const q = r.quotations?.[0];
      if (q?.grandTotal) salesRevenue += q.grandTotal;
    });

    // Cost of Goods Sold (vendor purchases)
    const pos = await PurchaseOrder.find({
      orderDate: dateFilter,
      status: { $in: ["COMPLETED", "PARTIALLY_RECEIVED"] },
    })
      .select("totalAmount")
      .lean();

    const cogs = pos.reduce((sum, po) => sum + (po.totalAmount || 0), 0);

    // Operating expenses
    const expenses = await Expense.find({
      createdAt: dateFilter,
      status: { $ne: "void" },
    })
      .select("totalAmount category")
      .lean();

    const operatingExpenses = {};
    let totalOperatingExpenses = 0;
    expenses.forEach((e) => {
      if (!operatingExpenses[e.category]) operatingExpenses[e.category] = 0;
      operatingExpenses[e.category] += e.totalAmount || 0;
      totalOperatingExpenses += e.totalAmount || 0;
    });

    // Payroll costs
    const payrollItems = await PayrollItem.find({
      createdAt: dateFilter,
      status: { $in: ["processed", "paid"] },
    })
      .select("earnings.grossEarnings deductions.totalDeductions netPay")
      .lean();

    const totalPayrollCost = payrollItems.reduce((sum, p) => sum + (p.earnings?.grossEarnings || 0), 0);

    const grossProfit = salesRevenue - cogs;
    const netProfit = grossProfit - totalOperatingExpenses - totalPayrollCost;

    res.json({
      success: true,
      profitAndLoss: {
        revenue: { salesRevenue: parseFloat(salesRevenue.toFixed(2)) },
        costOfGoodsSold: parseFloat(cogs.toFixed(2)),
        grossProfit: parseFloat(grossProfit.toFixed(2)),
        grossProfitMargin: salesRevenue > 0 ? parseFloat(((grossProfit / salesRevenue) * 100).toFixed(1)) : 0,
        operatingExpenses,
        totalOperatingExpenses: parseFloat(totalOperatingExpenses.toFixed(2)),
        payrollCost: parseFloat(totalPayrollCost.toFixed(2)),
        netProfit: parseFloat(netProfit.toFixed(2)),
        netProfitMargin: salesRevenue > 0 ? parseFloat(((netProfit / salesRevenue) * 100).toFixed(1)) : 0,
      },
    });
  } catch (error) {
    console.error("P&L error:", error);
    res.status(500).json({ success: false, message: "Error generating P&L" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/accountant/dashboard/balance-sheet
// ═══════════════════════════════════════════════════════════════
router.get("/balance-sheet", async (req, res) => {
  try {
    // Assets - Receivables
    const requests = await CustomerRequest.find()
      .select("quotations totalPaidAmount")
      .lean();

    let totalReceivables = 0;
    requests.forEach((r) => {
      const q = r.quotations?.[0];
      if (q?.grandTotal) {
        totalReceivables += (q.grandTotal - (r.totalPaidAmount || 0));
      }
    });

    // Bank balances
    const bankTxns = await BankTransaction.find().sort({ transactionDate: -1 }).lean();
    const bankBalances = {};
    bankTxns.forEach((txn) => {
      if (!bankBalances[txn.bankAccount] && txn.runningBalance !== undefined) {
        bankBalances[txn.bankAccount] = {
          bankName: txn.bankName,
          balance: txn.runningBalance,
        };
      }
    });

    // Liabilities - Payables
    const pos = await PurchaseOrder.find({
      status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] },
    })
      .select("totalAmount payments")
      .lean();

    let totalPayables = 0;
    pos.forEach((po) => {
      const paid = po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
      totalPayables += (po.totalAmount || 0) - paid;
    });

    // Salary payable
    const pendingPayroll = await PayrollItem.find({ status: "pending" })
      .select("netPay")
      .lean();
    const salaryPayable = pendingPayroll.reduce((s, p) => s + (p.netPay || 0), 0);

    // Tax payable
    const pendingTaxes = await TaxFiling.find({ status: { $in: ["pending", "upcoming"] } })
      .select("totalPayable amountPaid")
      .lean();
    const taxPayable = pendingTaxes.reduce((s, t) => s + ((t.totalPayable || 0) - (t.amountPaid || 0)), 0);

    res.json({
      success: true,
      balanceSheet: {
        assets: {
          currentAssets: {
            accountsReceivable: parseFloat(totalReceivables.toFixed(2)),
            bankBalances,
          },
        },
        liabilities: {
          currentLiabilities: {
            accountsPayable: parseFloat(totalPayables.toFixed(2)),
            salaryPayable: parseFloat(salaryPayable.toFixed(2)),
            taxPayable: parseFloat(taxPayable.toFixed(2)),
          },
        },
      },
    });
  } catch (error) {
    console.error("Balance sheet error:", error);
    res.status(500).json({ success: false, message: "Error generating balance sheet" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/accountant/dashboard/cash-flow
// ═══════════════════════════════════════════════════════════════
router.get("/cash-flow", async (req, res) => {
  try {
    const { months = 6 } = req.query;
    const today = new Date();
    const cashFlowData = [];

    for (let i = parseInt(months) - 1; i >= 0; i--) {
      const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
      const label = monthStart.toLocaleString("en-IN", { month: "short", year: "numeric" });

      // Inflows
      const monthRequests = await CustomerRequest.find({
        createdAt: { $gte: monthStart, $lte: monthEnd },
      })
        .select("totalPaidAmount")
        .lean();

      const inflow = monthRequests.reduce((s, r) => s + (r.totalPaidAmount || 0), 0);

      // Outflows
      const monthExpenses = await Expense.find({
        createdAt: { $gte: monthStart, $lte: monthEnd },
        status: { $ne: "void" },
      })
        .select("totalAmount")
        .lean();

      const expenseOutflow = monthExpenses.reduce((s, e) => s + (e.totalAmount || 0), 0);

      const monthPayroll = await PayrollItem.find({
        createdAt: { $gte: monthStart, $lte: monthEnd },
        status: { $in: ["processed", "paid"] },
      })
        .select("netPay")
        .lean();

      const payrollOutflow = monthPayroll.reduce((s, p) => s + (p.netPay || 0), 0);

      cashFlowData.push({
        month: label,
        inflow: parseFloat(inflow.toFixed(2)),
        outflow: parseFloat((expenseOutflow + payrollOutflow).toFixed(2)),
        net: parseFloat((inflow - expenseOutflow - payrollOutflow).toFixed(2)),
      });
    }

    res.json({ success: true, cashFlow: cashFlowData });
  } catch (error) {
    console.error("Cash flow error:", error);
    res.status(500).json({ success: false, message: "Error generating cash flow" });
  }
});

module.exports = router;
