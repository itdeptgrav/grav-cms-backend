// routes/Accountant_Routes/Acc_reports.js
// Complete Financial Reports Routes

const express = require("express");
const { istStart, istEnd, istMonthBounds } = require("../../services/accounting/istDates");
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

/* ── THE GST SUMMARY, FROM THE BOOKS (16 Oct 2026 audit) ─────────────────
   What was wrong, measured on this company's vouchers:
   • every GST line was ADDED whatever its side, so a credit note's reversal
     (Dr Output CGST — ₹4.77 lakh of it) raised output tax instead of
     lowering it, and a debit note raised ITC;
   • the monthly set-off and payment journals (Dr Output CGST 2.5% ₹3.18
     lakh against Cr Input …, Dr CGST Payable / Cr Receivable) were read as
     tax on supplies, so output tax and ITC were both inflated by the very
     entries that clear them;
   • the HSN summary took purchase lines too, added pieces to metres and
     grouped by HSN alone;
   • it always reported the PRIMARY company.

   Now:
   • only supplies count — sales and credit notes (outward), purchases and
     debit notes (inward), and expenses booked through the expense module.
     Journals, payments and contras are settlements, not supplies;
   • a line is signed by its side: an output ledger counts Cr +, Dr −; an
     input ledger Dr +, Cr −. A credit note therefore REDUCES output tax and
     taxable value, a debit note reduces ITC, and reverse-charge tax on a
     purchase (Cr Output … RCM) is counted as the liability it is;
   • the rate, HSN and invoice tables carry the same sign (a note is a
     negative row);
   • HSN is sales-side only, one row per HSN + rate + unit, its taxable value
     scaled onto the ledger base like the rate table;
   • the company is the one asked for (`companyId`), else the primary one. */
const GST_SLABS = [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40];
const OUTWARD_TYPES = new Set(["sales", "credit_note"]);
const INWARD_TYPES = new Set(["purchase", "debit_note"]);

async function voucherDerivedGst(startDate, endDate, companyId) {
  let company = null;
  if (companyId && mongoose.Types.ObjectId.isValid(String(companyId))) {
    company = await Acc_Company.findById(companyId).select("_id").lean();
  }
  if (!company) company = await Acc_Company.findOne({ isPrimary: true }).select("_id").lean();
  if (!company) {
    const all = await Acc_Company.find({}).select("_id").limit(2).lean();
    if (all.length === 1) company = all[0];
  }
  if (!company) return null;

  const match = { companyId: company._id, status: "posted", isOptional: { $ne: true } };
  if (startDate && endDate) {
    match.voucherDate = { $gte: istStart(startDate), $lte: istEnd(endDate) };
  }

  const vouchers = await Acc_Voucher.find(match)
    .select("voucherType sourceSystem ledgerEntries inventoryEntries voucherDate voucherNumber partyLedgerName")
    .lean();
  if (!vouchers.length) return null;

  const out = { cgst: 0, sgst: 0, igst: 0, cess: 0, taxable: 0 };
  const inp = { cgst: 0, sgst: 0, igst: 0, cess: 0, taxable: 0 };
  let outCount = 0;
  let inCount = 0;
  const outByRate = {};
  const inByRate = {};
  const b2b = { taxable: 0, tax: 0, count: 0 };
  const b2c = { taxable: 0, tax: 0, count: 0 };
  const hsnMap = {};
  const outInvoices = [];
  const inInvoices = [];

  const addRate = (bucket, rate, vals) => {
    const key = String(rate || 0);
    if (!bucket[key]) bucket[key] = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    for (const k of ["taxable", "cgst", "sgst", "igst", "cess"]) bucket[key][k] += vals[k] || 0;
  };

  for (const v of vouchers) {
    const isSalesSide = OUTWARD_TYPES.has(v.voucherType);
    const isPurchSide = INWARD_TYPES.has(v.voucherType) || v.sourceSystem === "expense_module";
    if (!isSalesSide && !isPurchSide) continue; // a settlement, not a supply

    let touchedOut = false;
    let touchedIn = false;
    /* this voucher's own tax and base, signed for the side it reports on */
    const vt = { cgst: 0, sgst: 0, igst: 0, cess: 0 };
    let vTaxable = 0;
    for (const e of v.ledgerEntries || []) {
      const amt = e.amount || 0;
      const c = classifyGstLedger(e.ledgerName);
      if (c) {
        const dir = c.dir || (isSalesSide ? "outward" : "inward");
        if (dir === "outward") {
          const signed = e.type === "Cr" ? amt : -amt;
          out[c.comp] += signed;
          touchedOut = true;
          if (isSalesSide) vt[c.comp] += signed;
        } else {
          const signed = e.type === "Dr" ? amt : -amt;
          inp[c.comp] += signed;
          touchedIn = true;
          if (isPurchSide) vt[c.comp] += signed;
        }
        continue;
      }
      // Taxable base = the sales / purchase ledger line only — never the
      // party total (base + tax) or round-off.
      const lname = String(e.ledgerName || "").toLowerCase();
      const grp = String(e.groupName || "").toLowerCase();
      const isSalesLedger = /\bsales?\b/.test(lname) || grp.includes("sales account") || grp.includes("direct inco");
      const isPurchLedger = /\bpurchase?\b/.test(lname) || grp.includes("purchase account") || grp.includes("direct expens");
      if (isSalesSide && isSalesLedger) {
        const signed = e.type === "Cr" ? amt : -amt;
        out.taxable += signed;
        vTaxable += signed;
      } else if (isPurchSide && !isSalesSide && isPurchLedger) {
        const signed = e.type === "Dr" ? amt : -amt;
        inp.taxable += signed;
        vTaxable += signed;
      }
    }
    if (touchedOut && isSalesSide) outCount++;
    if (touchedIn && isPurchSide) inCount++;

    const vTax = vt.cgst + vt.sgst + vt.igst + vt.cess;
    const sgn = (vTaxable || vTax) < 0 ? -1 : 1;
    const vBaseAbs = Math.abs(vTaxable);
    const vTaxAbs = Math.abs(vt.cgst) + Math.abs(vt.sgst) + Math.abs(vt.igst);

    // Effective rate of the voucher, snapped to the nearest slab.
    let effRate = 0;
    if (vBaseAbs > 0 && vTaxAbs > 0) {
      const raw = (vTaxAbs / vBaseAbs) * 100;
      effRate = GST_SLABS.reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best));
    }

    /* Lines are used for the rate split only when the tax they imply
       reconciles with the tax the voucher carries (old Tally imports store
       no per-line rate); otherwise the voucher's effective rate stands. The
       ledger base stays authoritative — line amounts are scaled onto it. */
    const invLines = (v.inventoryEntries || []).filter((i) => !i.isCharge);
    const lineBase = invLines.reduce((s, i) => s + Math.abs(i.amount || 0), 0);
    const lineTaxTotal = invLines.reduce((s, i) => s + (Math.abs(i.amount || 0) * Number(i.taxRate || 0)) / 100, 0);
    const linesReconcile =
      invLines.length > 0 && lineBase > 0 && vBaseAbs > 0 &&
      Math.abs(lineTaxTotal - vTaxAbs) <= Math.max(2, vTaxAbs * 0.02);
    const scale = lineBase > 0 && vBaseAbs > 0 ? vBaseAbs / lineBase : 1;

    const rateBucket = isSalesSide ? outByRate : inByRate;
    if (vBaseAbs > 0 || vTaxAbs > 0) {
      if (linesReconcile) {
        const baseByRate = new Map();
        for (const it of invLines) {
          const r = Number(it.taxRate || 0);
          baseByRate.set(r, (baseByRate.get(r) || 0) + Math.abs(it.amount || 0) * scale);
        }
        for (const [r, base] of baseByRate) {
          const share = vTaxAbs > 0 ? (base * r) / 100 / vTaxAbs : 0;
          addRate(rateBucket, r, {
            taxable: sgn * base,
            cgst: sgn * Math.abs(vt.cgst) * share,
            sgst: sgn * Math.abs(vt.sgst) * share,
            igst: sgn * Math.abs(vt.igst) * share,
            cess: sgn * Math.abs(vt.cess) * share,
          });
        }
      } else {
        addRate(rateBucket, effRate, {
          taxable: sgn * vBaseAbs,
          cgst: sgn * Math.abs(vt.cgst),
          sgst: sgn * Math.abs(vt.sgst),
          igst: sgn * Math.abs(vt.igst),
          cess: sgn * Math.abs(vt.cess),
        });
      }
    }

    // HSN summary — outward supplies only, one row per HSN + rate + unit.
    if (isSalesSide) {
      const isIgst = Math.abs(vt.igst) > Math.abs(vt.cgst);
      for (const it of invLines) {
        const h = it.hsnCode ? String(it.hsnCode).trim() : "";
        if (!h) continue;
        const rate = linesReconcile ? Number(it.taxRate || 0) : effRate;
        const unit = String(it.unit || "").trim().toUpperCase() || "NOS";
        const key = `${h}|${rate}|${unit}`;
        const base = sgn * Math.abs(it.amount || 0) * scale;
        const tax = (base * rate) / 100;
        if (!hsnMap[key]) hsnMap[key] = { hsn: h, rate, unit, quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
        hsnMap[key].quantity += sgn * Math.abs(it.quantity || 0);
        hsnMap[key].taxable += base;
        if (isIgst) hsnMap[key].igst += tax;
        else {
          hsnMap[key].cgst += tax / 2;
          hsnMap[key].sgst += tax / 2;
        }
      }
    }

    // Invoice registers (a note is a negative row).
    const rec = {
      voucherNumber: v.voucherNumber,
      voucherType: v.voucherType,
      date: v.voucherDate,
      party: v.partyLedgerName || "",
      taxableValue: vTaxable,
      cgst: vt.cgst,
      sgst: vt.sgst,
      igst: vt.igst,
      cess: vt.cess,
      totalTax: vTax,
    };
    if (isSalesSide && (touchedOut || vTaxable)) outInvoices.push(rec);
    else if (isPurchSide && (touchedIn || vTaxable)) inInvoices.push(rec);
  }

  // B2B vs B2C: a party ledger with a GSTIN is B2B.
  const partyNames = [...new Set(outInvoices.map((r) => r.party).filter(Boolean))];
  const gstinByParty = {};
  if (partyNames.length) {
    const { Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
    const leds = await Acc_Ledger.find({ companyId: company._id, name: { $in: partyNames } }).select("name gstin").lean();
    for (const l of leds) gstinByParty[l.name] = (l.gstin || "").trim();
  }
  for (const r of outInvoices) {
    const hasGstin = !!gstinByParty[r.party];
    r.type = hasGstin ? "B2B" : "B2C";
    r.partyGstin = gstinByParty[r.party] || "";
    const bucket = hasGstin ? b2b : b2c;
    bucket.taxable += r.taxableValue;
    bucket.tax += r.totalTax;
    bucket.count += 1;
  }

  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const roundObj = (o) => {
    const r = {};
    for (const k of Object.keys(o)) r[k] = typeof o[k] === "number" ? r2(o[k]) : o[k];
    return r;
  };
  const taxOf = (o) => r2((o.cgst || 0) + (o.sgst || 0) + (o.igst || 0) + (o.cess || 0));
  const rateRows = (bucket) =>
    Object.keys(bucket)
      .sort((a, b) => parseFloat(a) - parseFloat(b))
      .map((rate) => ({ rate: parseFloat(rate), ...roundObj(bucket[rate]), totalTax: taxOf(bucket[rate]) }));

  const outputTax = out.cgst + out.sgst + out.igst + out.cess;
  const inputTax = inp.cgst + inp.sgst + inp.igst + inp.cess;

  return {
    outputGST: {
      totalTaxableValue: r2(out.taxable),
      totalCGST: r2(out.cgst),
      totalSGST: r2(out.sgst),
      totalIGST: r2(out.igst),
      totalCess: r2(out.cess),
      totalTax: r2(outputTax),
      invoiceCount: outCount,
    },
    inputGST: {
      totalTaxableValue: r2(inp.taxable),
      totalCGST: r2(inp.cgst),
      totalSGST: r2(inp.sgst),
      totalIGST: r2(inp.igst),
      totalCess: r2(inp.cess),
      totalTax: r2(inputTax),
      expenseCount: inCount,
    },
    netGSTPayable: r2(outputTax - inputTax),
    inputTaxCredit: r2(inputTax),
    gstr3b: {
      outwardByRate: rateRows(outByRate),
      inwardByRate: rateRows(inByRate),
      b2b: roundObj(b2b),
      b2c: roundObj(b2c),
      hsnSummary: Object.values(hsnMap)
        .map((h) => ({ ...roundObj(h), totalTax: taxOf(h) }))
        .sort((a, b) => b.taxable - a.taxable),
    },
    outwardInvoices: outInvoices.map(roundObj).sort((a, b) => new Date(a.date) - new Date(b.date)),
    inwardInvoices: inInvoices.map(roundObj).sort((a, b) => new Date(a.date) - new Date(b.date)),
    companyId: String(company._id),
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
router.get("/gst", (req, res, next) => (req.query.companyId ? AccountantAuthMiddleware.requireCompanyScope(req, res, next) : next()), async (req, res) => {
  try {
    const { startDate, endDate, type = "summary", companyId } = req.query;
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = { $gte: istStart(startDate), $lte: istEnd(endDate) };
    }

    /* The books are the vouchers: read them first. The two collections
       below are an older bookkeeping path (empty on this company); they
       are read only when the books have nothing for the period. */
    const fromBooks = await voucherDerivedGst(startDate, endDate, companyId);
    if (fromBooks) return res.json({ success: true, gstReport: fromBooks });

    // Output GST (Sales)
    const invoices = await Acc_Invoice.find(
      dateFilter.$gte ? { invoiceDate: dateFilter } : {},
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
      totalEDLI: r.totalEDLI || 0,
      totalAdminCharges: r.totalAdminCharges || 0,
      employees: r.totalEmployees || 0,
      /* Everything the employer pays for the month. EDLI and PF admin charges
         are employer costs like PF and ESIC and were simply missing, so this
         figure understated the cost of every month it reported. Runs processed
         before they were recorded carry 0 and are unchanged by this. */
      employerCost:
        (r.totalGross || 0) +
        (r.totalPF || 0) +
        (r.totalESIC || 0) +
        (r.totalEDLI || 0) +
        (r.totalAdminCharges || 0),
    }));

    const annualSummary = {
      totalGross: monthlyCost.reduce((s, m) => s + m.totalGross, 0),
      totalNet: monthlyCost.reduce((s, m) => s + m.totalNetPay, 0),
      totalPF: monthlyCost.reduce((s, m) => s + m.totalPF, 0),
      totalESIC: monthlyCost.reduce((s, m) => s + m.totalESIC, 0),
      totalEDLI: monthlyCost.reduce((s, m) => s + m.totalEDLI, 0),
      totalAdminCharges: monthlyCost.reduce((s, m) => s + m.totalAdminCharges, 0),
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
      filter.createdAt = { $gte: istStart(startDate), $lte: istEnd(endDate) };
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
