// routes/Accountant_Routes/Acc_reports.js
// Complete Financial Reports Routes

const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Customer = require("../../models/Customer_Models/Customer");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const {
  Acc_Expense,
  Acc_Invoice,
  Acc_BankTransaction,
  Acc_TaxFiling,
} = require("../../models/Accountant_model/Acc_OperationalModels");
const mongoose = require("mongoose");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");

// Classify a ledger name into a GST component + direction. Imported
// Tally data posts tax to ledgers like "Output CGST 9%", "Input SGST",
// "IGST Payable", "GST Cess". We read those off the voucher lines when
// there are no Acc_Invoice/Acc_Expense rows (the Tally-import case).
function classifyGstLedger(name) {
  const n = String(name || "").toLowerCase();
  if (!/gst|cess/.test(n)) return null;
  let comp = null;
  if (/cess/.test(n)) comp = "cess";
  else if (/igst/.test(n)) comp = "igst";
  else if (/cgst/.test(n)) comp = "cgst";
  else if (/sgst|utgst/.test(n)) comp = "sgst";
  if (!comp) return null;
  let dir = null;
  if (/input/.test(n)) dir = "inward";
  else if (/output|payable/.test(n)) dir = "outward";
  return { comp, dir };
}

async function voucherDerivedGst(startDate, endDate) {
  // The GST page doesn't pass companyId, so resolve the primary/only
  // accounting company the same way the other bridges do.
  let company = await Acc_Company.findOne({ isPrimary: true })
    .select("_id")
    .lean();
  if (!company) {
    const all = await Acc_Company.find({}).select("_id").limit(2).lean();
    if (all.length === 1) company = all[0];
  }
  if (!company) return null;

  const match = { companyId: company._id, status: "posted" };
  if (startDate && endDate) {
    match.voucherDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  const vouchers = await Acc_Voucher.find(match)
    .select(
      "voucherType ledgerEntries inventoryEntries voucherDate voucherNumber partyLedgerName",
    )
    .lean();

  if (!vouchers.length) return null;

  const out = { cgst: 0, sgst: 0, igst: 0, cess: 0, taxable: 0 };
  const inp = { cgst: 0, sgst: 0, igst: 0, cess: 0, taxable: 0 };
  let outCount = 0;
  let inCount = 0;

  // GSTR-3B helpers ---------------------------------------------------
  // rate-wise: { "5": {taxable, cgst, sgst, igst, cess}, "12": {...} }
  const outByRate = {};
  const inByRate = {};
  // B2B vs B2C (a sale is B2B when the party has a GSTIN; we look it up
  // on the party ledger). Without a reliable per-voucher GSTIN we treat
  // a party ledger that has gstin set as B2B.
  const b2b = { taxable: 0, tax: 0, count: 0 };
  const b2c = { taxable: 0, tax: 0, count: 0 };
  // HSN summary: { "6109": { hsn, qty, taxable, cgst, sgst, igst, cess } }
  const hsnMap = {};
  const outInvoices = [];
  const inInvoices = [];

  const addRate = (bucket, rate, vals) => {
    const key = String(rate || 0);
    if (!bucket[key])
      bucket[key] = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    bucket[key].taxable += vals.taxable || 0;
    bucket[key].cgst += vals.cgst || 0;
    bucket[key].sgst += vals.sgst || 0;
    bucket[key].igst += vals.igst || 0;
    bucket[key].cess += vals.cess || 0;
  };

  for (const v of vouchers) {
    const isSalesSide = ["sales", "credit_note"].includes(v.voucherType);
    const isPurchSide = ["purchase", "debit_note"].includes(v.voucherType);
    let touchedOut = false;
    let touchedIn = false;
    let vCgst = 0;
    let vSgst = 0;
    let vIgst = 0;
    let vCess = 0;
    let vTaxable = 0;
    for (const e of v.ledgerEntries || []) {
      const c = classifyGstLedger(e.ledgerName);
      const amt = e.amount || 0;
      const lname = String(e.ledgerName || "").toLowerCase();
      const grp = String(e.groupName || "").toLowerCase();
      if (c) {
        const dir =
          c.dir || (isSalesSide ? "outward" : isPurchSide ? "inward" : null);
        if (dir === "outward") {
          out[c.comp] += amt;
          touchedOut = true;
          if (c.comp === "cgst") vCgst += amt;
          else if (c.comp === "sgst") vSgst += amt;
          else if (c.comp === "igst") vIgst += amt;
          else if (c.comp === "cess") vCess += amt;
        } else if (dir === "inward") {
          inp[c.comp] += amt;
          touchedIn = true;
          if (c.comp === "cgst") vCgst += amt;
          else if (c.comp === "sgst") vSgst += amt;
          else if (c.comp === "igst") vIgst += amt;
          else if (c.comp === "cess") vCess += amt;
        }
      } else {
        // Taxable base = the SALES / PURCHASE revenue/expense ledger
        // line only — NOT the party (debtor/creditor) total and NOT
        // round-off. The party line equals base+tax and would double
        // count. Identify the base ledger by name or its account group.
        const isSalesLedger =
          /\bsales?\b/.test(lname) ||
          grp.includes("sales account") ||
          grp.includes("direct inco");
        const isPurchLedger =
          /\bpurchase?\b/.test(lname) ||
          grp.includes("purchase account") ||
          grp.includes("direct expens");
        if (isSalesSide && isSalesLedger) {
          out.taxable += amt;
          vTaxable += amt;
        } else if (isPurchSide && isPurchLedger) {
          inp.taxable += amt;
          vTaxable += amt;
        }
      }
    }
    if (touchedOut) outCount++;
    if (touchedIn) inCount++;

    // ── Rate-wise + HSN ────────────────────────────────────────────
    // The OLD imports stored inventoryEntries WITHOUT gstRate/hsnCode,
    // so we must NOT depend on it. Instead derive the effective GST
    // rate for this voucher from the actual tax it carries vs its
    // taxable base (data already in the DB): rate ≈ tax / taxable.
    // Snap to the nearest standard Indian slab so 4.99 → 5, etc.
    const vTaxAbs = Math.abs(vCgst) + Math.abs(vSgst) + Math.abs(vIgst);
    const vBaseAbs = Math.abs(vTaxable);
    let effRate = 0;
    if (vBaseAbs > 0 && vTaxAbs > 0) {
      const raw = (vTaxAbs / vBaseAbs) * 100;
      const slabs = [0, 0.25, 3, 5, 12, 18, 28];
      effRate = slabs.reduce((best, s) =>
        Math.abs(s - raw) < Math.abs(best - raw) ? s : best,
      );
    }
    const rateVals = {
      taxable: vBaseAbs,
      cgst: Math.abs(vCgst),
      sgst: Math.abs(vSgst),
      igst: Math.abs(vIgst),
      cess: Math.abs(vCess),
    };
    if (isSalesSide && (vBaseAbs > 0 || vTaxAbs > 0)) {
      addRate(outByRate, effRate, rateVals);
    } else if (isPurchSide && (vBaseAbs > 0 || vTaxAbs > 0)) {
      addRate(inByRate, effRate, rateVals);
    }

    // HSN summary — use inventoryEntries when the (newer) import stored
    // hsnCode; otherwise skip silently (the rate-wise table above is
    // the authoritative GSTR-3B 3.1 view and is now DB-independent).
    const invs = v.inventoryEntries || [];
    for (const it of invs) {
      const h = it.hsnCode ? String(it.hsnCode).trim() : "";
      if (!h) continue;
      const base = Math.abs(it.amount || 0);
      // Apportion this line's tax by the voucher's effective rate.
      const lineTax = (base * effRate) / 100;
      const isIgst = Math.abs(vIgst) > Math.abs(vCgst);
      if (!hsnMap[h])
        hsnMap[h] = {
          hsn: h,
          quantity: 0,
          taxable: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
          cess: 0,
        };
      hsnMap[h].quantity += it.quantity || 0;
      hsnMap[h].taxable += base;
      if (isIgst) {
        hsnMap[h].igst += lineTax;
      } else {
        hsnMap[h].cgst += lineTax / 2;
        hsnMap[h].sgst += lineTax / 2;
      }
    }

    // B2B / B2C split + invoice register (sales side only).
    if (isSalesSide && (touchedOut || vTaxable)) {
      const taxTotal =
        Math.abs(vCgst) + Math.abs(vSgst) + Math.abs(vIgst) + Math.abs(vCess);
      const rec = {
        voucherNumber: v.voucherNumber,
        date: v.voucherDate,
        party: v.partyLedgerName || "",
        taxableValue: Math.abs(vTaxable),
        cgst: Math.abs(vCgst),
        sgst: Math.abs(vSgst),
        igst: Math.abs(vIgst),
        cess: Math.abs(vCess),
        totalTax: taxTotal,
      };
      outInvoices.push(rec);
    } else if (isPurchSide && (touchedIn || vTaxable)) {
      const taxTotal =
        Math.abs(vCgst) + Math.abs(vSgst) + Math.abs(vIgst) + Math.abs(vCess);
      inInvoices.push({
        voucherNumber: v.voucherNumber,
        date: v.voucherDate,
        party: v.partyLedgerName || "",
        taxableValue: Math.abs(vTaxable),
        cgst: Math.abs(vCgst),
        sgst: Math.abs(vSgst),
        igst: Math.abs(vIgst),
        cess: Math.abs(vCess),
        totalTax: taxTotal,
      });
    }
  }

  // B2B vs B2C: look up which party ledgers have a GSTIN.
  const partyNames = [
    ...new Set(outInvoices.map((r) => r.party).filter(Boolean)),
  ];
  let gstinByParty = {};
  if (partyNames.length) {
    const {
      Acc_Ledger,
    } = require("../../models/Accountant_model/Acc_MasterModels");
    const leds = await Acc_Ledger.find({
      companyId: company._id,
      name: { $in: partyNames },
    })
      .select("name gstin")
      .lean();
    for (const l of leds) gstinByParty[l.name] = (l.gstin || "").trim();
  }
  for (const r of outInvoices) {
    const hasGstin = !!gstinByParty[r.party];
    r.type = hasGstin ? "B2B" : "B2C";
    r.partyGstin = gstinByParty[r.party] || "";
    if (hasGstin) {
      b2b.taxable += r.taxableValue;
      b2b.tax += r.totalTax;
      b2b.count += 1;
    } else {
      b2c.taxable += r.taxableValue;
      b2c.tax += r.totalTax;
      b2c.count += 1;
    }
  }

  const roundObj = (o) => {
    const r = {};
    for (const k of Object.keys(o))
      r[k] =
        typeof o[k] === "number"
          ? Math.round(Math.abs(o[k]) * 100) / 100
          : o[k];
    return r;
  };
  const rateRows = (bucket) =>
    Object.keys(bucket)
      .sort((a, b) => parseFloat(a) - parseFloat(b))
      .map((rate) => ({
        rate: parseFloat(rate),
        ...roundObj(bucket[rate]),
        totalTax:
          Math.round(
            (Math.abs(bucket[rate].cgst) +
              Math.abs(bucket[rate].sgst) +
              Math.abs(bucket[rate].igst) +
              Math.abs(bucket[rate].cess)) *
              100,
          ) / 100,
      }));

  const outputTax = out.cgst + out.sgst + out.igst + out.cess;
  const inputTax = inp.cgst + inp.sgst + inp.igst + inp.cess;

  return {
    outputGST: {
      totalTaxableValue: Math.abs(out.taxable),
      totalCGST: Math.abs(out.cgst),
      totalSGST: Math.abs(out.sgst),
      totalIGST: Math.abs(out.igst),
      totalCess: Math.abs(out.cess),
      totalTax: Math.abs(outputTax),
      invoiceCount: outCount,
    },
    inputGST: {
      totalTaxableValue: Math.abs(inp.taxable),
      totalCGST: Math.abs(inp.cgst),
      totalSGST: Math.abs(inp.sgst),
      totalIGST: Math.abs(inp.igst),
      totalCess: Math.abs(inp.cess),
      totalTax: Math.abs(inputTax),
      expenseCount: inCount,
    },
    netGSTPayable: Math.abs(outputTax) - Math.abs(inputTax),
    inputTaxCredit: Math.abs(inputTax),
    // ── GSTR-3B style sections ──────────────────────────────────────
    gstr3b: {
      // 3.1(a) Outward taxable supplies, 4 Eligible ITC
      outwardByRate: rateRows(outByRate),
      inwardByRate: rateRows(inByRate),
      b2b: roundObj(b2b),
      b2c: roundObj(b2c),
      hsnSummary: Object.values(hsnMap)
        .map((h) => ({
          ...roundObj(h),
          totalTax:
            Math.round(
              (Math.abs(h.cgst) +
                Math.abs(h.sgst) +
                Math.abs(h.igst) +
                Math.abs(h.cess)) *
                100,
            ) / 100,
        }))
        .sort((a, b) => b.taxable - a.taxable),
    },
    outwardInvoices: outInvoices
      .map((r) => roundObj(r))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
    inwardInvoices: inInvoices
      .map((r) => roundObj(r))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
    source: "vouchers",
  };
}

router.use(AccountantAuthMiddleware.accountantAuth);

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

    const aging = {
      current: [],
      days_1_30: [],
      days_31_60: [],
      days_61_90: [],
      days_90_plus: [],
    };
    let totalOutstanding = 0;

    requests.forEach((r) => {
      const q = r.quotations?.[0];
      if (!q?.grandTotal) return;
      const outstanding = (q.grandTotal || 0) - (r.totalPaidAmount || 0);
      if (outstanding <= 0) return;

      const daysSince = Math.floor(
        (today - new Date(r.createdAt)) / (1000 * 60 * 60 * 24),
      );
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
          days_90_plus: aging.days_90_plus.reduce(
            (s, e) => s + e.outstanding,
            0,
          ),
        },
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error generating aging report" });
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

    const aging = {
      current: [],
      days_1_30: [],
      days_31_60: [],
      days_61_90: [],
      days_90_plus: [],
    };

    pos.forEach((po) => {
      const paid = po.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
      const outstanding = (po.totalAmount || 0) - paid;
      if (outstanding <= 0) return;

      const daysSince = Math.floor(
        (today - new Date(po.orderDate)) / (1000 * 60 * 60 * 24),
      );
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

    const totalOutstanding = [
      ...aging.current,
      ...aging.days_1_30,
      ...aging.days_31_60,
      ...aging.days_61_90,
      ...aging.days_90_plus,
    ].reduce((s, e) => s + e.outstanding, 0);

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
          days_90_plus: aging.days_90_plus.reduce(
            (s, e) => s + e.outstanding,
            0,
          ),
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error generating payables aging report",
    });
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
    const invoices = await Acc_Invoice.find(
      dateFilter.invoiceDate ? { invoiceDate: dateFilter } : {},
    )
      .select(
        "invoiceNumber invoiceDate customerName taxBreakdown grandTotal items",
      )
      .lean();

    const outputGST = {
      totalTaxableValue: invoices.reduce(
        (s, i) => s + (i.subtotal || i.grandTotal || 0),
        0,
      ),
      totalCGST: invoices.reduce((s, i) => s + (i.taxBreakdown?.cgst || 0), 0),
      totalSGST: invoices.reduce((s, i) => s + (i.taxBreakdown?.sgst || 0), 0),
      totalIGST: invoices.reduce((s, i) => s + (i.taxBreakdown?.igst || 0), 0),
      totalTax: invoices.reduce(
        (s, i) => s + (i.taxBreakdown?.totalTax || 0),
        0,
      ),
      invoiceCount: invoices.length,
    };

    // Input GST (Purchases)
    const expenses = await Acc_Expense.find({
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

    // If the operational collections have nothing (this company's data
    // came from a Tally import, which lands in Acc_Voucher, not
    // Acc_Invoice/Acc_Expense), derive GST from the voucher tax lines so
    // the report isn't empty. Keeps the invoice/expense path as primary
    // for any company that genuinely uses those collections.
    if (invoices.length === 0 && expenses.length === 0) {
      try {
        const vd = await voucherDerivedGst(startDate, endDate);
        if (vd) {
          return res.json({ success: true, gstReport: vd });
        }
      } catch (e) {
        console.error("[gst] voucher fallback:", e.message);
      }
    }

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
    res
      .status(500)
      .json({ success: false, message: "Error generating GST report" });
  }
});

// ── TDS Report ──
router.get("/tds", async (req, res) => {
  try {
    const { financialYear } = req.query;
    const expenses = await Acc_Expense.find({
      tdsApplicable: true,
      ...(financialYear ? { financialYear } : {}),
    })
      .select(
        "expenseId description vendorName tdsDetails totalAmount createdAt",
      )
      .lean();

    const summary = {
      totalDeductions: expenses.reduce(
        (s, e) => s + (e.tdsDetails?.tdsAmount || 0),
        0,
      ),
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
    res
      .status(500)
      .json({ success: false, message: "Error generating TDS report" });
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

    res.json({
      success: true,
      payrollCostReport: { monthlyCost, annualSummary },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error generating payroll report" });
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
      customerRevenue[custId].totalOutstanding +=
        (q?.grandTotal || 0) - (r.totalPaidAmount || 0);
    });

    const report = Object.values(customerRevenue).sort(
      (a, b) => b.totalRevenue - a.totalRevenue,
    );

    res.json({ success: true, revenueByCustomer: report });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error generating revenue report" });
  }
});

// ── Acc_Expense Summary Report ──
router.get("/expense-summary", async (req, res) => {
  try {
    const { startDate, endDate, financialYear } = req.query;
    let filter = { status: { $ne: "void" } };
    if (financialYear) filter.financialYear = financialYear;
    if (startDate && endDate) {
      filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const expenses = await Acc_Expense.find(filter)
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
      const monthKey = new Date(e.createdAt).toLocaleString("en-IN", {
        month: "short",
        year: "numeric",
      });
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
    res
      .status(500)
      .json({ success: false, message: "Error generating expense summary" });
  }
});

module.exports = router;
