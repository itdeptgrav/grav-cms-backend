/**
 * Tally Reports Routes
 * Trial Balance, Day Book, P&L, Balance Sheet, GST Summary, Cash Flow
 * All reports respect company scope and date range.
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { TallyVoucher } = require("../../models/Accountant_model/TallyVoucherModels");
const { TallyLedger, TallyGroup } = require("../../models/Accountant_model/TallyMasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const auth = accountantAuth;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function parseDateRange(req) {
  const { dateFrom, dateTo } = req.query;
  return {
    from: dateFrom ? new Date(dateFrom) : null,
    to: dateTo ? new Date(dateTo) : null
  };
}

function nestGroups(groups) {
  const byId = {};
  groups.forEach(g => { byId[g._id.toString()] = { ...g, children: [], ledgers: [] }; });
  const roots = [];
  Object.values(byId).forEach(g => {
    if (g.parentId && byId[g.parentId.toString()]) {
      byId[g.parentId.toString()].children.push(g);
    } else {
      roots.push(g);
    }
  });
  return { roots, byId };
}

/* ------------------------------------------------------------------ */
/* TRIAL BALANCE                                                       */
/* ------------------------------------------------------------------ */
/*
 * Returns groups+ledgers with debit/credit columns.
 * Computes per-ledger movement within date range PLUS opening balance carried forward.
 */
router.get("/trial-balance", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);

    // Pull groups & ledgers
    const groups = await TallyGroup.find({ companyId: cId, isActive: true }).lean();
    const ledgers = await TallyLedger.find({ companyId: cId, isActive: true }).lean();

    // Aggregate posted voucher entries per ledger within range
    const matchVoucher = { companyId: cId, status: "posted" };
    if (from || to) {
      matchVoucher.voucherDate = {};
      if (from) matchVoucher.voucherDate.$gte = from;
      if (to) matchVoucher.voucherDate.$lte = to;
    }

    const movements = await TallyVoucher.aggregate([
      { $match: matchVoucher },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledger",
          debitTotal: {
            $sum: { $cond: [{ $eq: ["$ledgerEntries.entryType", "Dr"] }, "$ledgerEntries.amount", 0] }
          },
          creditTotal: {
            $sum: { $cond: [{ $eq: ["$ledgerEntries.entryType", "Cr"] }, "$ledgerEntries.amount", 0] }
          }
        }
      }
    ]);

    const movementMap = {};
    movements.forEach(m => { movementMap[m._id.toString()] = m; });

    // For opening balance: if `from` is given, opening = current - movements_within_range
    // Simpler: opening = ledger.openingBalanceSigned (as configured at start of books)
    //          plus all movement BEFORE `from` if `from` is set.
    let priorMovements = [];
    if (from) {
      priorMovements = await TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherDate: { $lt: from } } },
        { $unwind: "$ledgerEntries" },
        {
          $group: {
            _id: "$ledgerEntries.ledger",
            net: { $sum: "$ledgerEntries.signedAmount" }
          }
        }
      ]);
    }
    const priorMap = {};
    priorMovements.forEach(p => { priorMap[p._id.toString()] = p.net; });

    // Build ledger rows
    const ledgerRows = ledgers.map(led => {
      const lid = led._id.toString();
      const mv = movementMap[lid] || { debitTotal: 0, creditTotal: 0 };
      const opening = (led.openingBalanceSigned || 0) + (priorMap[lid] || 0);
      const closing = opening + (mv.debitTotal - mv.creditTotal);
      return {
        ledgerId: led._id,
        ledgerName: led.name,
        groupId: led.groupId,
        groupName: led.groupName,
        opening,
        debit: mv.debitTotal,
        credit: mv.creditTotal,
        closing,
        closingType: closing >= 0 ? "Dr" : "Cr"
      };
    });

    // Group ledgers under groups (flat for trial balance — Tally style)
    const groupBuckets = {};
    ledgerRows.forEach(row => {
      const gid = row.groupId?.toString() || "ungrouped";
      if (!groupBuckets[gid]) groupBuckets[gid] = { ledgers: [], debit: 0, credit: 0 };
      groupBuckets[gid].ledgers.push(row);
      groupBuckets[gid].debit += row.debit;
      groupBuckets[gid].credit += row.credit;
    });

    const groupRows = groups.map(g => {
      const b = groupBuckets[g._id.toString()] || { ledgers: [], debit: 0, credit: 0 };
      return {
        groupId: g._id,
        groupName: g.name,
        nature: g.nature,
        parentId: g.parentId,
        debit: b.debit,
        credit: b.credit,
        ledgers: b.ledgers
      };
    });

    const totals = ledgerRows.reduce((acc, r) => {
      acc.debit += r.debit;
      acc.credit += r.credit;
      acc.openingDr += r.opening > 0 ? r.opening : 0;
      acc.openingCr += r.opening < 0 ? -r.opening : 0;
      acc.closingDr += r.closing > 0 ? r.closing : 0;
      acc.closingCr += r.closing < 0 ? -r.closing : 0;
      return acc;
    }, { debit: 0, credit: 0, openingDr: 0, openingCr: 0, closingDr: 0, closingCr: 0 });

    res.json({
      companyId,
      dateRange: { from, to },
      groups: groupRows,
      ledgers: ledgerRows,
      totals
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* DAY BOOK — chronological list of all vouchers                       */
/* ------------------------------------------------------------------ */
router.get("/day-book", auth, async (req, res) => {
  try {
    const { companyId, voucherType, status = "posted",
            page = 1, limit = 100 } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const filter = { companyId, status };
    if (voucherType) filter.voucherType = voucherType;
    if (from || to) {
      filter.voucherDate = {};
      if (from) filter.voucherDate.$gte = from;
      if (to) filter.voucherDate.$lte = to;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [vouchers, total] = await Promise.all([
      TallyVoucher.find(filter)
        .populate("partyLedger", "name")
        .sort({ voucherDate: 1, createdAt: 1 })
        .skip(skip).limit(Number(limit))
        .lean(),
      TallyVoucher.countDocuments(filter)
    ]);

    const totals = await TallyVoucher.aggregate([
      { $match: { ...filter, companyId: new mongoose.Types.ObjectId(companyId) } },
      { $group: { _id: null, debit: { $sum: "$totalDebit" }, credit: { $sum: "$totalCredit" } } }
    ]);

    res.json({
      items: vouchers,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
      totals: totals[0] || { debit: 0, credit: 0 }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* PROFIT & LOSS                                                       */
/* ------------------------------------------------------------------ */
/*
 * Sums revenue (Cr balance on revenue ledgers) - expenses (Dr balance on expense ledgers)
 * within date range, returns nested by group.
 */
router.get("/profit-loss", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);
    const groups = await TallyGroup.find({ companyId: cId, isActive: true }).lean();
    const ledgers = await TallyLedger.find({ companyId: cId, isActive: true }).lean();

    const groupMap = {};
    groups.forEach(g => { groupMap[g._id.toString()] = g; });

    const matchVoucher = { companyId: cId, status: "posted" };
    if (from || to) {
      matchVoucher.voucherDate = {};
      if (from) matchVoucher.voucherDate.$gte = from;
      if (to) matchVoucher.voucherDate.$lte = to;
    }

    const movements = await TallyVoucher.aggregate([
      { $match: matchVoucher },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledger",
          net: { $sum: "$ledgerEntries.signedAmount" }
        }
      }
    ]);
    const moveMap = {};
    movements.forEach(m => { moveMap[m._id.toString()] = m.net; });

    const revenueLines = [];
    const expenseLines = [];

    ledgers.forEach(led => {
      const grp = groupMap[led.groupId?.toString()];
      if (!grp) return;
      const net = moveMap[led._id.toString()] || 0;
      // Revenue: credit balance is income → -net (since signed is Dr-positive)
      // Expense: debit balance is expense → +net
      if (grp.nature === "revenue") {
        revenueLines.push({
          ledgerId: led._id,
          ledgerName: led.name,
          groupName: led.groupName,
          amount: -net  // credit-side gives income
        });
      } else if (grp.nature === "expense") {
        expenseLines.push({
          ledgerId: led._id,
          ledgerName: led.name,
          groupName: led.groupName,
          amount: net  // debit-side gives expense
        });
      }
    });

    const totalRevenue = revenueLines.reduce((s, l) => s + l.amount, 0);
    const totalExpense = expenseLines.reduce((s, l) => s + l.amount, 0);
    const netProfit = totalRevenue - totalExpense;

    // Group sub-totals
    const groupSummary = (lines) => {
      const map = {};
      lines.forEach(l => {
        map[l.groupName] = (map[l.groupName] || 0) + l.amount;
      });
      return Object.entries(map).map(([groupName, amount]) => ({ groupName, amount }));
    };

    res.json({
      companyId,
      dateRange: { from, to },
      revenue: { lines: revenueLines, byGroup: groupSummary(revenueLines), total: totalRevenue },
      expense: { lines: expenseLines, byGroup: groupSummary(expenseLines), total: totalExpense },
      netProfit
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* BALANCE SHEET                                                       */
/* ------------------------------------------------------------------ */
/*
 * As-of date snapshot: for each ledger compute closing balance =
 * openingBalanceSigned + sum of signedAmount across all postings up to date.
 * Group by nature: assets / liabilities / equity.
 */
router.get("/balance-sheet", auth, async (req, res) => {
  try {
    const { companyId, asOf } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const asOfDate = asOf ? new Date(asOf) : new Date();

    const cId = new mongoose.Types.ObjectId(companyId);
    const groups = await TallyGroup.find({ companyId: cId, isActive: true }).lean();
    const ledgers = await TallyLedger.find({ companyId: cId, isActive: true }).lean();

    const groupMap = {};
    groups.forEach(g => { groupMap[g._id.toString()] = g; });

    const movements = await TallyVoucher.aggregate([
      { $match: { companyId: cId, status: "posted", voucherDate: { $lte: asOfDate } } },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledger",
          net: { $sum: "$ledgerEntries.signedAmount" }
        }
      }
    ]);
    const moveMap = {};
    movements.forEach(m => { moveMap[m._id.toString()] = m.net; });

    // Compute net profit (revenue - expense) up to asOf and add to equity
    let revenueNet = 0, expenseNet = 0;
    const buckets = { asset: [], liability: [], equity: [] };

    ledgers.forEach(led => {
      const grp = groupMap[led.groupId?.toString()];
      if (!grp) return;
      const closing = (led.openingBalanceSigned || 0) + (moveMap[led._id.toString()] || 0);
      const line = {
        ledgerId: led._id,
        ledgerName: led.name,
        groupName: led.groupName,
        amount: Math.abs(closing),
        signedAmount: closing
      };
      if (grp.nature === "asset") buckets.asset.push(line);
      else if (grp.nature === "liability") buckets.liability.push({ ...line, amount: -closing });
      else if (grp.nature === "equity") buckets.equity.push({ ...line, amount: -closing });
      else if (grp.nature === "revenue") revenueNet += -closing;
      else if (grp.nature === "expense") expenseNet += closing;
    });

    const netProfit = revenueNet - expenseNet;
    if (netProfit !== 0) {
      buckets.equity.push({
        ledgerName: "Net Profit (Current Period)",
        groupName: "Profit & Loss",
        amount: netProfit,
        signedAmount: -netProfit,
        synthetic: true
      });
    }

    const sumOf = arr => arr.reduce((s, x) => s + x.amount, 0);

    res.json({
      companyId,
      asOf: asOfDate,
      assets: { lines: buckets.asset, total: sumOf(buckets.asset) },
      liabilities: { lines: buckets.liability, total: sumOf(buckets.liability) },
      equity: { lines: buckets.equity, total: sumOf(buckets.equity) },
      check: {
        assetsTotal: sumOf(buckets.asset),
        liabEquityTotal: sumOf(buckets.liability) + sumOf(buckets.equity),
        difference: sumOf(buckets.asset) - (sumOf(buckets.liability) + sumOf(buckets.equity))
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GST SUMMARY (GSTR-1 / GSTR-3B style)                                */
/* ------------------------------------------------------------------ */
router.get("/gst-summary", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);
    const match = { companyId: cId, status: "posted" };
    if (from || to) {
      match.voucherDate = {};
      if (from) match.voucherDate.$gte = from;
      if (to) match.voucherDate.$lte = to;
    }

    // Outward (Sales + Credit Notes against)
    const outward = await TallyVoucher.aggregate([
      { $match: { ...match, voucherType: { $in: ["sales", "credit_note"] } } },
      {
        $group: {
          _id: "$voucherType",
          count: { $sum: 1 },
          taxable: { $sum: "$gstBreakup.taxableValue" },
          cgst: { $sum: "$gstBreakup.cgst" },
          sgst: { $sum: "$gstBreakup.sgst" },
          igst: { $sum: "$gstBreakup.igst" },
          cess: { $sum: "$gstBreakup.cess" },
          total: { $sum: "$gstBreakup.total" },
          grandTotal: { $sum: "$grandTotal" }
        }
      }
    ]);

    // Inward (Purchase + Debit Notes against)
    const inward = await TallyVoucher.aggregate([
      { $match: { ...match, voucherType: { $in: ["purchase", "debit_note"] } } },
      {
        $group: {
          _id: "$voucherType",
          count: { $sum: 1 },
          taxable: { $sum: "$gstBreakup.taxableValue" },
          cgst: { $sum: "$gstBreakup.cgst" },
          sgst: { $sum: "$gstBreakup.sgst" },
          igst: { $sum: "$gstBreakup.igst" },
          cess: { $sum: "$gstBreakup.cess" },
          total: { $sum: "$gstBreakup.total" },
          grandTotal: { $sum: "$grandTotal" }
        }
      }
    ]);

    const sumGroup = arr => arr.reduce((acc, r) => {
      acc.count += r.count;
      acc.taxable += r.taxable || 0;
      acc.cgst += r.cgst || 0;
      acc.sgst += r.sgst || 0;
      acc.igst += r.igst || 0;
      acc.cess += r.cess || 0;
      acc.total += r.total || 0;
      acc.grandTotal += r.grandTotal || 0;
      return acc;
    }, { count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, grandTotal: 0 });

    const outwardTotals = sumGroup(outward);
    const inwardTotals = sumGroup(inward);

    res.json({
      companyId,
      dateRange: { from, to },
      outward: { breakdown: outward, totals: outwardTotals },
      inward: { breakdown: inward, totals: inwardTotals },
      netGstPayable: {
        cgst: outwardTotals.cgst - inwardTotals.cgst,
        sgst: outwardTotals.sgst - inwardTotals.sgst,
        igst: outwardTotals.igst - inwardTotals.igst,
        cess: outwardTotals.cess - inwardTotals.cess,
        total: (outwardTotals.cgst + outwardTotals.sgst + outwardTotals.igst + outwardTotals.cess)
              - (inwardTotals.cgst + inwardTotals.sgst + inwardTotals.igst + inwardTotals.cess)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* CASH FLOW (simplified: movements on cash & bank ledgers)            */
/* ------------------------------------------------------------------ */
router.get("/cash-flow", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);
    // Find cash & bank ledgers — Tally groups: "Cash-in-Hand", "Bank Accounts"
    const cashGroups = await TallyGroup.find({
      companyId: cId,
      name: { $in: ["Cash-in-Hand", "Bank Accounts", "Bank OD A/c"] }
    }).select("_id").lean();
    const cashGroupIds = cashGroups.map(g => g._id);
    const cashLedgers = await TallyLedger.find({
      companyId: cId,
      groupId: { $in: cashGroupIds }
    }).lean();
    const cashLedgerIds = cashLedgers.map(l => l._id);

    const match = {
      companyId: cId,
      status: "posted",
      "ledgerEntries.ledger": { $in: cashLedgerIds }
    };
    if (from || to) {
      match.voucherDate = {};
      if (from) match.voucherDate.$gte = from;
      if (to) match.voucherDate.$lte = to;
    }

    const flows = await TallyVoucher.aggregate([
      { $match: match },
      { $unwind: "$ledgerEntries" },
      { $match: { "ledgerEntries.ledger": { $in: cashLedgerIds } } },
      {
        $group: {
          _id: { ledger: "$ledgerEntries.ledger", type: "$voucherType" },
          inflow: {
            $sum: { $cond: [{ $eq: ["$ledgerEntries.entryType", "Dr"] }, "$ledgerEntries.amount", 0] }
          },
          outflow: {
            $sum: { $cond: [{ $eq: ["$ledgerEntries.entryType", "Cr"] }, "$ledgerEntries.amount", 0] }
          }
        }
      }
    ]);

    const ledMap = {};
    cashLedgers.forEach(l => { ledMap[l._id.toString()] = l; });

    const breakdown = flows.map(f => ({
      ledgerId: f._id.ledger,
      ledgerName: ledMap[f._id.ledger.toString()]?.name || "Unknown",
      voucherType: f._id.type,
      inflow: f.inflow,
      outflow: f.outflow,
      net: f.inflow - f.outflow
    }));

    const totals = breakdown.reduce((a, b) => {
      a.inflow += b.inflow;
      a.outflow += b.outflow;
      a.net += b.net;
      return a;
    }, { inflow: 0, outflow: 0, net: 0 });

    res.json({ companyId, dateRange: { from, to }, breakdown, totals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* DASHBOARD — quick KPIs for the homepage                             */
/* ------------------------------------------------------------------ */
router.get("/dashboard", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const cId = new mongoose.Types.ObjectId(companyId);

    const today = new Date();
    const thirtyAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fyStart = new Date(today.getFullYear(), today.getMonth() >= 3 ? 3 : -9, 1);

    const [recent30Sales, recent30Purchases, recent30Receipts, recent30Payments,
           fySales, fyPurchases, recentVouchers, ledgerCount] = await Promise.all([
      TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherType: "sales", voucherDate: { $gte: thirtyAgo } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } }
      ]),
      TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherType: "purchase", voucherDate: { $gte: thirtyAgo } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } }
      ]),
      TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherType: "receipt", voucherDate: { $gte: thirtyAgo } } },
        { $group: { _id: null, total: { $sum: "$totalDebit" }, count: { $sum: 1 } } }
      ]),
      TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherType: "payment", voucherDate: { $gte: thirtyAgo } } },
        { $group: { _id: null, total: { $sum: "$totalCredit" }, count: { $sum: 1 } } }
      ]),
      TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherType: "sales", voucherDate: { $gte: fyStart } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } }
      ]),
      TallyVoucher.aggregate([
        { $match: { companyId: cId, status: "posted", voucherType: "purchase", voucherDate: { $gte: fyStart } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } }
      ]),
      TallyVoucher.find({ companyId: cId }).sort("-createdAt").limit(8)
        .populate("partyLedger", "name").lean(),
      TallyLedger.countDocuments({ companyId: cId, isActive: true })
    ]);

    const v = (a) => (a[0]?.total) || 0;
    const c = (a) => (a[0]?.count) || 0;

    res.json({
      last30Days: {
        sales: { total: v(recent30Sales), count: c(recent30Sales) },
        purchases: { total: v(recent30Purchases), count: c(recent30Purchases) },
        receipts: { total: v(recent30Receipts), count: c(recent30Receipts) },
        payments: { total: v(recent30Payments), count: c(recent30Payments) }
      },
      fyToDate: {
        sales: v(fySales),
        purchases: v(fyPurchases),
        gross: v(fySales) - v(fyPurchases)
      },
      ledgerCount,
      recentVouchers
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
