// routes/Accountant_Routes/tallyChartOfAccounts.js
// =============================================================================
// CHART OF ACCOUNTS — Groups + Ledgers
// -----------------------------------------------------------------------------
// Endpoints:
//   GET    /tree                        — Group→Ledger tree (with rollups)
//   GET    /trial-balance               — Flat trial balance (Dr/Cr columns,
//                                          group totals, balanced check)
//   GET    /groups, POST/PUT/DELETE     — Group CRUD
//   GET    /groups/:id/statement        — Consolidated statement for a group
//                                          (all descendant ledgers in one view)
//   GET    /ledgers, POST/PUT/DELETE    — Ledger CRUD
//   GET    /ledgers/:id/statement       — Ledger statement (running balance,
//                                          monthly + daily buckets, contra
//                                          entries, bill-wise outstanding,
//                                          previous-period comparison)
//   POST   /ledgers/:id/transactions    — Quick add 2-line journal voucher
//   GET    /payroll/runs                — List payroll runs + posting status
//   GET    /payroll/runs/:id/preview    — Preview salary journal voucher
//   POST   /payroll/runs/:id/post       — Post a single payroll run as voucher
//   POST   /payroll/runs/post-all       — Post every unposted run
//   POST   /payroll/runs/:id/unpost     — Cancel the auto-created voucher
// =============================================================================

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  TallyGroup,
  TallyLedger,
} = require("../../models/Accountant_model/TallyMasterModels");
const {
  TallyVoucher,
} = require("../../models/Accountant_model/TallyVoucherModels");
// Payroll models live in the HR module. We require them lazily inside the
// payroll endpoints below so this route file still loads on systems that don't
// have the HR module installed yet.

router.use(accountantAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helper — sum currentBalance for a list of leaf ledgers (signed)
// ─────────────────────────────────────────────────────────────────────────────
function sumBalances(ledgers = []) {
  return ledgers.reduce((acc, l) => acc + (l.currentBalance || 0), 0);
}

function rollupGroupTotals(group) {
  // Recursively sum: the group's own ledgers + all descendant groups' totals
  const ownTotal = sumBalances(group.ledgers || []);
  const childTotal = (group.children || []).reduce(
    (acc, c) => acc + rollupGroupTotals(c),
    0,
  );
  group.rolledUpBalance = ownTotal + childTotal;
  group.totalLedgersDeep =
    (group.ledgers?.length || 0) +
    (group.children || []).reduce(
      (acc, c) => acc + (c.totalLedgersDeep || 0),
      0,
    );
  return group.rolledUpBalance;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/tree?companyId=...
// Returns the full Group→Ledger tree + per-group rolled-up balances
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tree", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const [groups, ledgers] = await Promise.all([
      TallyGroup.find({ companyId, isActive: true }).lean(),
      TallyLedger.find({ companyId, isActive: true }).lean(),
    ]);

    const groupMap = new Map(
      groups.map((g) => [String(g._id), { ...g, children: [], ledgers: [] }]),
    );

    ledgers.forEach((l) => {
      const parent = groupMap.get(String(l.groupId));
      if (parent) parent.ledgers.push(l);
    });

    const roots = [];
    groupMap.forEach((g) => {
      if (g.parent) {
        const p = groupMap.get(String(g.parent));
        if (p) p.children.push(g);
        else roots.push(g);
      } else {
        roots.push(g);
      }
    });

    // Roll up balances bottom-up
    roots.forEach(rollupGroupTotals);

    const order = ["asset", "liability", "equity", "revenue", "expense"];
    roots.sort((a, b) => {
      const oa = order.indexOf(a.nature);
      const ob = order.indexOf(b.nature);
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });

    // Top-level totals by nature (handy for the page header strip)
    const totalsByNature = roots.reduce((acc, g) => {
      acc[g.nature] = (acc[g.nature] || 0) + (g.rolledUpBalance || 0);
      return acc;
    }, {});

    res.json({
      success: true,
      tree: roots,
      stats: {
        totalGroups: groups.length,
        totalLedgers: ledgers.length,
        totalsByNature,
      },
    });
  } catch (err) {
    console.error("CoA tree:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUPS — CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/groups", async (req, res) => {
  try {
    const { companyId, nature, parent } = req.query;
    const filter = { isActive: true };
    if (companyId) filter.companyId = companyId;
    if (nature) filter.nature = nature;
    if (parent === "null") filter.parent = null;
    else if (parent) filter.parent = parent;
    const groups = await TallyGroup.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/groups", async (req, res) => {
  try {
    const { companyId, name, parent, nature, description } = req.body;
    if (!companyId || !name || !nature) {
      return res
        .status(400)
        .json({
          success: false,
          message: "companyId, name, nature are required",
        });
    }
    let parentDoc = null;
    if (parent) {
      parentDoc = await TallyGroup.findById(parent);
      if (!parentDoc)
        return res
          .status(404)
          .json({ success: false, message: "Parent group not found" });
    }
    const group = await TallyGroup.create({
      companyId,
      name,
      nature,
      description,
      parent: parentDoc?._id || null,
      parentName: parentDoc?.name || null,
      level: parentDoc ? (parentDoc.level || 1) + 1 : 1,
      fullPath: parentDoc ? `${parentDoc.fullPath} > ${name}` : name,
      isReserved: false,
      createdBy: req.user?.id,
    });
    res.status(201).json({ success: true, group });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put("/groups/:id", async (req, res) => {
  try {
    const grp = await TallyGroup.findById(req.params.id);
    if (!grp)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    if (grp.isReserved && req.body.name && req.body.name !== grp.name) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Cannot rename a reserved Tally group",
        });
    }
    Object.assign(grp, req.body);
    await grp.save();
    res.json({ success: true, group: grp });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete("/groups/:id", async (req, res) => {
  try {
    const grp = await TallyGroup.findById(req.params.id);
    if (!grp)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    if (grp.isReserved)
      return res
        .status(400)
        .json({ success: false, message: "Cannot delete a reserved group" });

    const childCount = await TallyGroup.countDocuments({
      parent: grp._id,
      isActive: true,
    });
    const ledgerCount = await TallyLedger.countDocuments({
      groupId: grp._id,
      isActive: true,
    });
    if (childCount > 0 || ledgerCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Group has ${childCount} sub-group(s) and ${ledgerCount} ledger(s). Move or delete them first.`,
      });
    }
    grp.isActive = false;
    await grp.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEDGERS — CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ledgers", async (req, res) => {
  try {
    const {
      companyId,
      groupId,
      nature,
      search,
      page = 1,
      limit = 50,
    } = req.query;
    const filter = { isActive: true };
    if (companyId) filter.companyId = companyId;
    if (groupId) filter.groupId = groupId;
    if (nature) filter.nature = nature;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { aliases: { $regex: search, $options: "i" } },
        { gstin: { $regex: search, $options: "i" } },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [ledgers, total] = await Promise.all([
      TallyLedger.find(filter)
        .sort({ name: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      TallyLedger.countDocuments(filter),
    ]);
    res.json({
      success: true,
      ledgers,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/ledgers", async (req, res) => {
  try {
    const { companyId, name, groupId, openingBalance, openingBalanceType } =
      req.body;
    if (!companyId || !name || !groupId) {
      return res
        .status(400)
        .json({ success: false, message: "companyId, name, groupId required" });
    }
    const group = await TallyGroup.findById(groupId);
    if (!group)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });

    const signedOpen =
      (openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(parseFloat(openingBalance) || 0);

    const ledger = await TallyLedger.create({
      ...req.body,
      groupName: group.name,
      nature: req.body.nature || group.nature,
      openingBalance: signedOpen,
      currentBalance: signedOpen,
      currentBalanceType: openingBalanceType || "Dr",
      createdBy: req.user?.id,
    });
    res.status(201).json({ success: true, ledger });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/ledgers/:id", async (req, res) => {
  try {
    const ledger = await TallyLedger.findById(req.params.id).lean();
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    res.json({ success: true, ledger });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/ledgers/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.groupId) {
      const grp = await TallyGroup.findById(updates.groupId);
      if (grp) {
        updates.groupName = grp.name;
        if (!updates.nature) updates.nature = grp.nature;
      }
    }
    // Re-sign opening balance if both fields supplied
    if (updates.openingBalance != null && updates.openingBalanceType) {
      const sign = updates.openingBalanceType === "Cr" ? -1 : 1;
      updates.openingBalance =
        sign * Math.abs(parseFloat(updates.openingBalance) || 0);
    }
    const ledger = await TallyLedger.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    res.json({ success: true, ledger });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete("/ledgers/:id", async (req, res) => {
  try {
    const ledger = await TallyLedger.findById(req.params.id);
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });

    const txnCount = await TallyVoucher.countDocuments({
      "ledgerEntries.ledgerId": ledger._id,
      status: "posted",
    });
    if (txnCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Ledger has ${txnCount} posted transactions. Reverse or void them first.`,
      });
    }
    ledger.isActive = false;
    await ledger.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/ledgers/:id/statement
// Full ledger statement returns three views in one payload:
//   • lines           — flat chronological list with running balance
//   • monthlySummary  — one row per month: opening, debit, credit, closing
//   • openingBalanceLine — synthetic row for the opening balance
//
// Math (consistent across all views):
//   running          = opening + Σ(debit − credit)         per row
//   month.closing    = month.opening + month.debit − month.credit
//   month[i].opening = month[i-1].closing                  carry-forward
//   period.closing   = monthlySummary.last.closing
//                    = opening + totals.debit − totals.credit
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ledgers/:id/statement", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const ledger = await TallyLedger.findById(req.params.id).lean();
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      dateFilter.$lte = e;
    }

    const filter = {
      "ledgerEntries.ledgerId": ledger._id,
      status: "posted",
    };
    if (Object.keys(dateFilter).length) filter.voucherDate = dateFilter;

    const vouchers = await TallyVoucher.find(filter)
      .sort({ voucherDate: 1, createdAt: 1 })
      .select(
        "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal",
      )
      .lean();

    // Opening balance — sum all entries strictly before startDate, plus the
    // ledger's stored openingBalance figure
    let opening = ledger.openingBalance || 0;
    if (startDate) {
      const priorAgg = await TallyVoucher.aggregate([
        {
          $match: {
            "ledgerEntries.ledgerId": ledger._id,
            status: "posted",
            voucherDate: { $lt: new Date(startDate) },
          },
        },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": ledger._id } },
        {
          $group: { _id: null, total: { $sum: "$ledgerEntries.signedAmount" } },
        },
      ]);
      opening += priorAgg[0]?.total || 0;
    }

    // Build flat running statement
    let running = opening;
    const lines = vouchers.map((v) => {
      const myLines = v.ledgerEntries.filter(
        (e) => String(e.ledgerId) === String(ledger._id),
      );
      const otherLines = v.ledgerEntries.filter(
        (e) => String(e.ledgerId) !== String(ledger._id),
      );
      const dr = myLines.reduce(
        (s, e) => s + (e.type === "Dr" ? e.amount : 0),
        0,
      );
      const cr = myLines.reduce(
        (s, e) => s + (e.type === "Cr" ? e.amount : 0),
        0,
      );
      const signed = dr - cr;
      running += signed;

      // Pull bill-wise allocations from MY lines (not other ledgers)
      const myBills = myLines.flatMap((e) =>
        (e.billAllocations || []).map((b) => ({
          billName: b.billName,
          billType: b.billType,
          amount: b.amount,
          dueDate: b.dueDate,
          creditDays: b.creditDays,
        })),
      );

      return {
        voucherId: v._id,
        date: v.voucherDate,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherTypeName,
        voucherNumber: v.voucherNumber,
        particulars: v.partyLedgerName || v.narration || "",
        narration: v.narration,
        debit: dr,
        credit: cr,
        runningBalance: running,
        runningBalanceType: running >= 0 ? "Dr" : "Cr",
        // ── New fields ────────────────────────────────────────────────
        // Tally-style "By/To" contras: when this row is Dr, the others are Cr (shown as "To")
        // When this row is Cr, the others are Dr (shown as "By").
        // Convention: under the leading line, the contras are listed indented.
        contraEntries: otherLines.map((e) => ({
          ledgerId: e.ledgerId,
          ledgerName: e.ledgerName,
          groupName: e.groupName,
          type: e.type,
          amount: e.amount,
        })),
        billAllocations: myBills,
      };
    });

    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    const closing = running;

    // ── Monthly summary buckets ─────────────────────────────────────────
    // Each month's opening = previous month's closing.
    const byMonth = new Map();
    for (const l of lines) {
      const d = new Date(l.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!byMonth.has(key)) {
        byMonth.set(key, {
          monthKey: key,
          year: d.getFullYear(),
          month: d.getMonth() + 1,
          monthName: d.toLocaleString("en-IN", { month: "long" }),
          monthShort: d.toLocaleString("en-IN", { month: "short" }),
          debit: 0,
          credit: 0,
          txCount: 0,
        });
      }
      const bucket = byMonth.get(key);
      bucket.debit += l.debit;
      bucket.credit += l.credit;
      bucket.txCount += 1;
    }

    // Walk months in chronological order, carrying balance forward
    let monthRunning = opening;
    const monthlySummary = Array.from(byMonth.values())
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map((m) => {
        const monthOpening = monthRunning;
        const monthClosing = monthOpening + m.debit - m.credit;
        monthRunning = monthClosing;
        return {
          ...m,
          opening: monthOpening,
          openingType: monthOpening >= 0 ? "Dr" : "Cr",
          closing: monthClosing,
          closingType: monthClosing >= 0 ? "Dr" : "Cr",
          netChange: m.debit - m.credit,
        };
      });

    // ── Daily summary buckets ───────────────────────────────────────────
    const byDay = new Map();
    for (const l of lines) {
      const d = new Date(l.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!byDay.has(key)) {
        byDay.set(key, {
          dayKey: key,
          date: d,
          debit: 0,
          credit: 0,
          txCount: 0,
        });
      }
      const bucket = byDay.get(key);
      bucket.debit += l.debit;
      bucket.credit += l.credit;
      bucket.txCount += 1;
    }
    let dayRunning = opening;
    const dailySummary = Array.from(byDay.values())
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
      .map((d) => {
        const dayOpening = dayRunning;
        const dayClosing = dayOpening + d.debit - d.credit;
        dayRunning = dayClosing;
        return {
          ...d,
          opening: dayOpening,
          openingType: dayOpening >= 0 ? "Dr" : "Cr",
          closing: dayClosing,
          closingType: dayClosing >= 0 ? "Dr" : "Cr",
          netChange: d.debit - d.credit,
        };
      });

    // ── Bill-wise outstanding (party ledgers under Sundry Debtors/Creditors) ─
    // FIFO: sum signedAmount across all bills with the same billName.
    // Positive remaining = receivable (Dr); negative = payable (Cr).
    let billWiseOutstanding = null;
    const groupName = (ledger.groupName || "").toLowerCase();
    const isPartyLedger =
      groupName.includes("sundry debtor") ||
      groupName.includes("sundry creditor") ||
      groupName.includes("debtor") ||
      groupName.includes("creditor");
    if (isPartyLedger) {
      // Pull ALL allocations across history for this ledger, irrespective of period
      const allAlloc = await TallyVoucher.aggregate([
        { $match: { "ledgerEntries.ledgerId": ledger._id, status: "posted" } },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": ledger._id } },
        { $unwind: "$ledgerEntries.billAllocations" },
        {
          $project: {
            billName: "$ledgerEntries.billAllocations.billName",
            amount: "$ledgerEntries.billAllocations.amount",
            billType: "$ledgerEntries.billAllocations.billType",
            dueDate: "$ledgerEntries.billAllocations.dueDate",
            creditDays: "$ledgerEntries.billAllocations.creditDays",
            entryType: "$ledgerEntries.type",
            voucherDate: 1,
            voucherNumber: 1,
            voucherType: 1,
          },
        },
      ]);

      const billMap = new Map();
      for (const a of allAlloc) {
        if (!a.billName) continue;
        const key = a.billName;
        if (!billMap.has(key)) {
          billMap.set(key, {
            billName: a.billName,
            originalAmount: 0,
            settled: 0,
            remaining: 0,
            firstDate: a.voucherDate,
            dueDate: a.dueDate,
            creditDays: a.creditDays || 0,
            voucherNumbers: new Set(),
          });
        }
        const bill = billMap.get(key);
        bill.voucherNumbers.add(a.voucherNumber);
        // new_ref = original invoice (increases outstanding); agst_ref = payment against (decreases)
        const signed = (a.entryType === "Dr" ? 1 : -1) * (a.amount || 0);
        bill.remaining += signed;
        if (a.billType === "new_ref") bill.originalAmount += a.amount || 0;
        if (
          !bill.firstDate ||
          new Date(a.voucherDate) < new Date(bill.firstDate)
        )
          bill.firstDate = a.voucherDate;
      }

      const today = new Date();
      const buckets = {
        current: 0,
        "0-30": 0,
        "31-60": 0,
        "61-90": 0,
        "90+": 0,
      };
      const openBills = [];
      for (const bill of billMap.values()) {
        if (Math.abs(bill.remaining) < 0.01) continue; // settled
        const daysOverdue = bill.dueDate
          ? Math.max(0, Math.floor((today - new Date(bill.dueDate)) / 86400000))
          : Math.max(
              0,
              Math.floor((today - new Date(bill.firstDate)) / 86400000) -
                (bill.creditDays || 0),
            );
        let bucket = "current";
        if (daysOverdue > 0) bucket = "0-30";
        if (daysOverdue > 30) bucket = "31-60";
        if (daysOverdue > 60) bucket = "61-90";
        if (daysOverdue > 90) bucket = "90+";
        buckets[bucket] += Math.abs(bill.remaining);

        openBills.push({
          billName: bill.billName,
          firstDate: bill.firstDate,
          dueDate: bill.dueDate || null,
          creditDays: bill.creditDays,
          originalAmount: bill.originalAmount,
          remaining: bill.remaining,
          remainingAbs: Math.abs(bill.remaining),
          remainingType: bill.remaining >= 0 ? "Dr" : "Cr",
          daysOverdue,
          bucket,
          voucherCount: bill.voucherNumbers.size,
        });
      }
      openBills.sort((a, b) => b.daysOverdue - a.daysOverdue);

      billWiseOutstanding = {
        applicable: true,
        totalOutstanding: openBills.reduce(
          (s, b) => s + b.remainingAbs * (b.remainingType === "Dr" ? 1 : -1),
          0,
        ),
        bills: openBills,
        agingBuckets: buckets,
        bucketTotals: {
          current: buckets.current,
          d0_30: buckets["0-30"],
          d31_60: buckets["31-60"],
          d61_90: buckets["61-90"],
          d90Plus: buckets["90+"],
        },
      };
    }

    // ── Previous-period comparison ──────────────────────────────────────
    // Same date span, one year earlier
    let previousPeriodComparison = null;
    if (startDate && endDate) {
      const s = new Date(startDate);
      s.setFullYear(s.getFullYear() - 1);
      const e = new Date(endDate);
      e.setFullYear(e.getFullYear() - 1);
      e.setHours(23, 59, 59, 999);
      const prevAgg = await TallyVoucher.aggregate([
        {
          $match: {
            "ledgerEntries.ledgerId": ledger._id,
            status: "posted",
            voucherDate: { $gte: s, $lte: e },
          },
        },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": ledger._id } },
        {
          $group: {
            _id: null,
            debit: {
              $sum: {
                $cond: [
                  { $eq: ["$ledgerEntries.type", "Dr"] },
                  "$ledgerEntries.amount",
                  0,
                ],
              },
            },
            credit: {
              $sum: {
                $cond: [
                  { $eq: ["$ledgerEntries.type", "Cr"] },
                  "$ledgerEntries.amount",
                  0,
                ],
              },
            },
            txCount: { $sum: 1 },
          },
        },
      ]);
      const p = prevAgg[0] || { debit: 0, credit: 0, txCount: 0 };
      previousPeriodComparison = {
        startDate: s.toISOString().slice(0, 10),
        endDate: e.toISOString().slice(0, 10),
        debit: p.debit,
        credit: p.credit,
        txCount: p.txCount,
        debitDelta: totalDebit - p.debit,
        creditDelta: totalCredit - p.credit,
        debitGrowthPct:
          p.debit > 0 ? ((totalDebit - p.debit) / p.debit) * 100 : null,
        creditGrowthPct:
          p.credit > 0 ? ((totalCredit - p.credit) / p.credit) * 100 : null,
      };
    }

    // Synthetic opening row (so the transactions table is never empty)
    const openingBalanceLine = {
      isSynthetic: true,
      date: ledger.openingBalanceDate || null,
      voucherType: "—",
      voucherTypeName: "Opening",
      voucherNumber: "—",
      particulars: "Opening Balance",
      narration: "Brought forward from previous period",
      debit: opening > 0 ? opening : 0,
      credit: opening < 0 ? Math.abs(opening) : 0,
      runningBalance: opening,
      runningBalanceType: opening >= 0 ? "Dr" : "Cr",
    };

    res.json({
      success: true,
      ledger: {
        _id: ledger._id,
        name: ledger.name,
        groupName: ledger.groupName,
        companyId: ledger.companyId,
        nature: ledger.nature,
        gstin: ledger.gstin,
        panNumber: ledger.panNumber,
        currentBalance: ledger.currentBalance,
        currentBalanceType: ledger.currentBalanceType,
        openingBalance: ledger.openingBalance,
        openingBalanceType: ledger.openingBalanceType,
        billWiseEnabled: ledger.billWiseEnabled,
        contactDetails: ledger.contactDetails,
        linkedEmployeeId: ledger.linkedEmployeeId,
        linkedCustomerId: ledger.linkedCustomerId,
        linkedVendorId: ledger.linkedVendorId,
      },
      period: { startDate, endDate },
      opening: { amount: Math.abs(opening), type: opening >= 0 ? "Dr" : "Cr" },
      openingBalanceLine,
      lines,
      monthlySummary,
      dailySummary,
      billWiseOutstanding,
      previousPeriodComparison,
      totals: { debit: totalDebit, credit: totalCredit },
      closing: { amount: Math.abs(closing), type: closing >= 0 ? "Dr" : "Cr" },
    });
  } catch (err) {
    console.error("Ledger statement:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/chart-of-accounts/ledgers/:id/transactions
// Quick "Add Transaction" — posts a 2-line journal voucher with this ledger
// on one side and the chosen contra ledger on the other side. The existing
// pre-save hook on TallyVoucher computes signedAmount; we then update the
// currentBalance on both ledgers in one bulkWrite. Same primitive every other
// voucher uses, just exposed as a one-shot endpoint for the ledger view.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/ledgers/:id/transactions", async (req, res) => {
  try {
    const ledgerId = req.params.id;
    const {
      contraLedgerId,
      type, // "Dr" or "Cr" — applied to THIS ledger
      amount,
      voucherDate,
      narration,
      voucherType: vchType, // optional: "journal" | "receipt" | "payment" | "contra"
      referenceNumber,
    } = req.body;

    // ─── Validate ───────────────────────────────────────────────────────
    if (!contraLedgerId)
      return res
        .status(400)
        .json({ success: false, message: "contraLedgerId required" });
    if (!["Dr", "Cr"].includes(type))
      return res
        .status(400)
        .json({ success: false, message: "type must be Dr or Cr" });
    const amt = parseFloat(amount);
    if (!amt || amt <= 0)
      return res
        .status(400)
        .json({ success: false, message: "amount must be a positive number" });
    if (String(ledgerId) === String(contraLedgerId)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "contra ledger cannot be the same as this ledger",
        });
    }

    const [thisLedger, contraLedger] = await Promise.all([
      TallyLedger.findById(ledgerId),
      TallyLedger.findById(contraLedgerId),
    ]);
    if (!thisLedger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });
    if (!contraLedger)
      return res
        .status(404)
        .json({ success: false, message: "Contra ledger not found" });
    if (String(thisLedger.companyId) !== String(contraLedger.companyId)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Both ledgers must belong to the same company",
        });
    }

    // ─── Build the voucher ──────────────────────────────────────────────
    const resolvedType =
      vchType && ["journal", "receipt", "payment", "contra"].includes(vchType)
        ? vchType
        : "journal";

    const number = await TallyVoucher.nextVoucherNumber(
      thisLedger.companyId,
      resolvedType,
    );
    const date = voucherDate ? new Date(voucherDate) : new Date();

    const contraType = type === "Dr" ? "Cr" : "Dr";

    const voucher = new TallyVoucher({
      companyId: thisLedger.companyId,
      voucherType: resolvedType,
      voucherTypeName: {
        journal: "Journal",
        receipt: "Receipt",
        payment: "Payment",
        contra: "Contra",
      }[resolvedType],
      voucherNumber: number,
      voucherDate: date,
      referenceNumber: referenceNumber || "",
      narration: narration || "",
      ledgerEntries: [
        {
          ledgerId: thisLedger._id,
          ledgerName: thisLedger.name,
          groupName: thisLedger.groupName,
          type,
          amount: amt,
        },
        {
          ledgerId: contraLedger._id,
          ledgerName: contraLedger.name,
          groupName: contraLedger.groupName,
          type: contraType,
          amount: amt,
        },
      ],
      grandTotal: amt,
      status: "posted",
      createdBy: req.user?.id,
    });

    await voucher.save(); // pre-save hook fills signedAmount + totals + financialYear

    // ─── Update ledger balances ─────────────────────────────────────────
    // Use the schema's `ledgerId` field (signedAmount = +amount for Dr, -amount for Cr)
    const ops = voucher.ledgerEntries.map((e) => ({
      updateOne: {
        filter: { _id: e.ledgerId },
        update: { $inc: { currentBalance: e.signedAmount } },
      },
    }));
    await TallyLedger.bulkWrite(ops);

    // Refresh balanceType on both touched ledgers
    for (const e of voucher.ledgerEntries) {
      const led = await TallyLedger.findById(e.ledgerId);
      if (led) {
        led.currentBalanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
        await led.save();
      }
    }

    res.status(201).json({
      success: true,
      voucher: {
        _id: voucher._id,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        voucherDate: voucher.voucherDate,
      },
    });
  } catch (err) {
    console.error("Quick add transaction:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/trial-balance?companyId=...&asOf=...
// Trial Balance — flat list of all ledgers with computed Dr/Cr columns.
// Includes opening + period transactions + closing in a single row per ledger.
// Total Dr should equal Total Cr (basic accounting identity).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trial-balance", async (req, res) => {
  try {
    const { companyId, startDate, endDate } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const ledgers = await TallyLedger.find({ companyId, isActive: true })
      .sort({ groupName: 1, name: 1 })
      .lean();

    const dateMatch = {};
    if (startDate) dateMatch.$gte = new Date(startDate);
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      dateMatch.$lte = e;
    }

    // Aggregate per-ledger debit/credit totals in the period
    const periodMatch = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: "posted",
    };
    if (Object.keys(dateMatch).length) periodMatch.voucherDate = dateMatch;

    const periodAgg = await TallyVoucher.aggregate([
      { $match: periodMatch },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          debit: {
            $sum: {
              $cond: [
                { $eq: ["$ledgerEntries.type", "Dr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
          credit: {
            $sum: {
              $cond: [
                { $eq: ["$ledgerEntries.type", "Cr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
          txCount: { $sum: 1 },
        },
      },
    ]);
    const periodMap = new Map(periodAgg.map((a) => [String(a._id), a]));

    // Aggregate opening totals (everything strictly before startDate)
    let openingMap = new Map();
    if (startDate) {
      const openAgg = await TallyVoucher.aggregate([
        {
          $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            status: "posted",
            voucherDate: { $lt: new Date(startDate) },
          },
        },
        { $unwind: "$ledgerEntries" },
        {
          $group: {
            _id: "$ledgerEntries.ledgerId",
            total: { $sum: "$ledgerEntries.signedAmount" },
          },
        },
      ]);
      openingMap = new Map(openAgg.map((a) => [String(a._id), a.total]));
    }

    const rows = ledgers.map((l) => {
      const period = periodMap.get(String(l._id)) || {
        debit: 0,
        credit: 0,
        txCount: 0,
      };
      const priorTxn = openingMap.get(String(l._id)) || 0;
      const opening = (l.openingBalance || 0) + priorTxn;
      const closing = opening + period.debit - period.credit;
      return {
        ledgerId: l._id,
        name: l.name,
        groupName: l.groupName,
        nature: l.nature,
        opening,
        openingType: opening >= 0 ? "Dr" : "Cr",
        debit: period.debit,
        credit: period.credit,
        txCount: period.txCount,
        closing,
        closingType: closing >= 0 ? "Dr" : "Cr",
        // Flat Dr/Cr columns (typical Tally trial balance format):
        // ledger goes into the Dr column if its closing is +ve, Cr column if -ve
        drColumn: closing >= 0 ? closing : 0,
        crColumn: closing < 0 ? Math.abs(closing) : 0,
      };
    });

    // Filter out completely-zero ledgers? Keep them — auditors want to see "not used yet" too.
    // Group totals
    const byGroup = new Map();
    for (const r of rows) {
      if (!byGroup.has(r.groupName)) {
        byGroup.set(r.groupName, {
          groupName: r.groupName,
          nature: r.nature,
          debit: 0,
          credit: 0,
          drColumn: 0,
          crColumn: 0,
        });
      }
      const g = byGroup.get(r.groupName);
      g.debit += r.debit;
      g.credit += r.credit;
      g.drColumn += r.drColumn;
      g.crColumn += r.crColumn;
    }

    const totals = {
      debit: rows.reduce((s, r) => s + r.debit, 0),
      credit: rows.reduce((s, r) => s + r.credit, 0),
      drColumn: rows.reduce((s, r) => s + r.drColumn, 0),
      crColumn: rows.reduce((s, r) => s + r.crColumn, 0),
    };
    totals.balanced = Math.abs(totals.drColumn - totals.crColumn) < 0.01;
    totals.imbalance = totals.drColumn - totals.crColumn;

    res.json({
      success: true,
      period: { startDate: startDate || null, endDate: endDate || null },
      ledgers: rows,
      groups: Array.from(byGroup.values()).sort((a, b) =>
        a.groupName.localeCompare(b.groupName),
      ),
      totals,
    });
  } catch (err) {
    console.error("Trial balance:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/chart-of-accounts/groups/:id/statement
// Group-level statement — consolidated transactions across all child ledgers.
// Used when accountant clicks a group node and wants to see "all postings under
// this group in one report" (e.g. "Show me all bank transactions").
// ─────────────────────────────────────────────────────────────────────────────
router.get("/groups/:id/statement", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const group = await TallyGroup.findById(req.params.id).lean();
    if (!group)
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });

    // Collect this group + all descendants recursively
    const allGroups = await TallyGroup.find({
      companyId: group.companyId,
      isActive: true,
    }).lean();
    const groupMap = new Map(allGroups.map((g) => [String(g._id), g]));
    function collectDescendantIds(rootId) {
      const ids = [String(rootId)];
      const queue = [String(rootId)];
      while (queue.length) {
        const cur = queue.shift();
        for (const g of allGroups) {
          if (String(g.parent) === cur) {
            ids.push(String(g._id));
            queue.push(String(g._id));
          }
        }
      }
      return ids;
    }
    const groupIds = collectDescendantIds(group._id);

    const ledgers = await TallyLedger.find({
      companyId: group.companyId,
      groupId: { $in: groupIds },
      isActive: true,
    }).lean();
    const ledgerIds = ledgers.map((l) => l._id);

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      dateFilter.$lte = e;
    }

    const filter = {
      "ledgerEntries.ledgerId": { $in: ledgerIds },
      status: "posted",
    };
    if (Object.keys(dateFilter).length) filter.voucherDate = dateFilter;

    const vouchers = await TallyVoucher.find(filter)
      .sort({ voucherDate: 1, createdAt: 1 })
      .select(
        "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal",
      )
      .lean();

    // Each row = one voucher entry within our scope
    const lines = [];
    let totalDebit = 0,
      totalCredit = 0;
    const ledgerIdSet = new Set(ledgerIds.map((id) => String(id)));
    for (const v of vouchers) {
      const myLines = v.ledgerEntries.filter((e) =>
        ledgerIdSet.has(String(e.ledgerId)),
      );
      for (const e of myLines) {
        const dr = e.type === "Dr" ? e.amount : 0;
        const cr = e.type === "Cr" ? e.amount : 0;
        totalDebit += dr;
        totalCredit += cr;
        lines.push({
          voucherId: v._id,
          date: v.voucherDate,
          voucherType: v.voucherType,
          voucherTypeName: v.voucherTypeName,
          voucherNumber: v.voucherNumber,
          ledgerName: e.ledgerName,
          ledgerId: e.ledgerId,
          particulars: v.partyLedgerName || v.narration || "",
          narration: v.narration,
          debit: dr,
          credit: cr,
        });
      }
    }

    res.json({
      success: true,
      group: {
        _id: group._id,
        name: group.name,
        nature: group.nature,
        fullPath: group.fullPath,
      },
      descendantGroupCount: groupIds.length - 1,
      ledgerCount: ledgers.length,
      period: { startDate, endDate },
      lines,
      totals: { debit: totalDebit, credit: totalCredit, txCount: lines.length },
    });
  } catch (err) {
    console.error("Group statement:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYROLL → LEDGER posting
//   GET  /payroll/runs                     — list payroll runs with posting status
//   POST /payroll/runs/:runId/post         — post a single run as a journal voucher
//   POST /payroll/runs/post-all            — post every unposted run for a company
//   GET  /payroll/runs/:runId/preview      — preview the journal voucher that would be created
//   POST /payroll/runs/:runId/unpost       — void the auto-created voucher (for re-posting)
//
// Payroll is computed and stored by the HR module (Payroll + PayrollItem
// collections). The HR module does NOT post journal vouchers on its own, so
// salary expense and statutory deductions never reach the chart of accounts.
//
// These endpoints bridge the gap. They generate a single Journal voucher per
// payroll run that follows standard Indian payroll accounting:
//
//   Dr   Salaries A/c                        (Total Gross Earnings)
//        Cr   Provident Fund Payable A/c     (Total PF deductions)
//        Cr   ESI Payable A/c                (Total ESI deductions)
//        Cr   Other Deductions Payable A/c   (Other deductions, if any)
//        Cr   Salary Payable A/c             (Net Pay  — to be paid via bank later)
//
// Idempotency: each voucher is tagged with sourceSystem="auto_from_payroll"
// and sourceId=payrollRunId. Re-posting the same run returns the existing
// voucher rather than creating a duplicate.
// ─────────────────────────────────────────────────────────────────────────────

// ── Helper: load HR Payroll models (lazy require so this file loads even if
// the HR module is missing in some environments) ─────────────────────────────
function loadPayrollModels() {
  try {
    return require("../../models/HR_Models/Payroll");
  } catch (e) {
    return null;
  }
}

// ── Helper: find-or-create a ledger by name under a group matching some hint
// We try multiple candidate group names (in priority order) and pick the first
// matching one that exists. If we can't find a sensible group, we fall back to
// the first group with the requested nature. If we can't find a ledger by any
// of the candidate names, we create one under the resolved group.
// ─────────────────────────────────────────────────────────────────────────────
async function findOrCreateLedger(
  companyId,
  ledgerNames,
  groupHints,
  requiredNature,
) {
  // 1) Try to find an existing ledger by any of the candidate names
  for (const name of ledgerNames) {
    const existing = await TallyLedger.findOne({
      companyId,
      isActive: true,
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    }).lean();
    if (existing) return existing;
  }

  // 2) No ledger by name. Find a target group.
  const allGroups = await TallyGroup.find({ companyId, isActive: true }).lean();

  let targetGroup = null;
  for (const hint of groupHints) {
    const re = new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    targetGroup = allGroups.find((g) => re.test(g.name));
    if (targetGroup) break;
  }
  if (!targetGroup) {
    targetGroup = allGroups.find(
      (g) => g.nature === requiredNature && !g.parent,
    );
  }
  if (!targetGroup) {
    throw new Error(
      `Cannot find a suitable group for ledger "${ledgerNames[0]}" — please create one under ${requiredNature} groups first.`,
    );
  }

  // 3) Create the ledger
  const ledger = await TallyLedger.create({
    companyId,
    name: ledgerNames[0],
    groupId: targetGroup._id,
    groupName: targetGroup.name,
    nature: targetGroup.nature,
    openingBalance: 0,
    openingBalanceType:
      targetGroup.nature === "expense" || targetGroup.nature === "asset"
        ? "Dr"
        : "Cr",
    isActive: true,
    notes: "Auto-created for payroll posting",
  });
  return ledger.toObject();
}

// ── GET /payroll/runs — list payroll runs with posting status ─────────────
router.get("/payroll/runs", async (req, res) => {
  try {
    const { companyId, year, status } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const HR = loadPayrollModels();
    if (!HR) return res.json({ success: true, runs: [], hrAvailable: false });
    const { Payroll, PayrollItem } = HR;

    const filter = {};
    if (year) filter.year = parseInt(year);
    if (status) filter.status = status;

    const runs = await Payroll.find(filter)
      .sort({ year: -1, month: -1 })
      .lean();

    // For each run, check whether a voucher already exists
    const runIds = runs.map((r) => r._id);
    const existingVouchers = await TallyVoucher.find({
      companyId,
      sourceSystem: "auto_from_payroll",
      sourceId: { $in: runIds },
    })
      .select("_id voucherNumber sourceId voucherDate grandTotal status")
      .lean();

    const voucherByRunId = new Map(
      existingVouchers.map((v) => [String(v.sourceId), v]),
    );

    res.json({
      success: true,
      hrAvailable: true,
      runs: runs.map((r) => ({
        _id: r._id,
        year: r.year,
        month: r.month,
        payPeriod: r.payPeriod,
        status: r.status,
        totalEmployees: r.totalEmployees,
        totalGross: r.totalGross || 0,
        totalDeductions: r.totalDeductions || 0,
        totalNetPay: r.totalNetPay || 0,
        totalPF: r.totalPF || 0,
        totalESIC: r.totalESIC || 0,
        createdAt: r.createdAt,
        // Posting status:
        postedToLedgers: voucherByRunId.has(String(r._id)),
        voucher: voucherByRunId.get(String(r._id)) || null,
      })),
    });
  } catch (err) {
    console.error("List payroll runs:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Helper: build the journal voucher payload from a payroll run ──────────
async function buildPayrollVoucher(companyId, run, items) {
  // Resolve every ledger we'll need
  const salariesLedger = await findOrCreateLedger(
    companyId,
    ["Salaries", "Salaries A/c", "Salary", "Wages & Salaries"],
    ["indirect expense", "salaries", "wages", "employee", "expenses"],
    "expense",
  );
  const pfPayable = await findOrCreateLedger(
    companyId,
    ["Provident Fund Payable", "PF Payable", "EPF Payable"],
    ["statutory", "current liab", "duties & taxes"],
    "liability",
  );
  const esiPayable = await findOrCreateLedger(
    companyId,
    ["ESI Payable", "ESIC Payable", "Employees State Insurance Payable"],
    ["statutory", "current liab", "duties & taxes"],
    "liability",
  );
  const otherDeductionsPayable = await findOrCreateLedger(
    companyId,
    ["Other Deductions Payable", "Salary Deductions Payable"],
    ["current liab", "statutory"],
    "liability",
  );
  const salaryPayable = await findOrCreateLedger(
    companyId,
    ["Salary Payable", "Salaries Payable", "Wages Payable"],
    ["current liab", "salary"],
    "liability",
  );

  // Aggregate totals from items (re-derive in case the run-level totals are stale)
  const totals = items.reduce(
    (a, i) => ({
      gross: a.gross + (i.earnings?.grossEarnings || 0),
      pf: a.pf + (i.deductions?.providentFund || 0),
      esi: a.esi + (i.deductions?.esic || 0),
      tdsOther:
        a.tdsOther +
        Math.max(
          0,
          (i.deductions?.totalDeductions || 0) -
            (i.deductions?.providentFund || 0) -
            (i.deductions?.esic || 0),
        ),
      net: a.net + (i.netPay || 0),
      count: a.count + 1,
    }),
    { gross: 0, pf: 0, esi: 0, tdsOther: 0, net: 0, count: 0 },
  );

  // Sanity-check: gross = net + total deductions (within rounding)
  const computedNet = totals.gross - totals.pf - totals.esi - totals.tdsOther;
  const diff = Math.abs(computedNet - totals.net);
  if (diff > 1) {
    // 1 rupee tolerance for cumulative rounding. If larger, something is off.
    throw new Error(
      `Payroll math doesn't reconcile: gross ${totals.gross.toFixed(2)} − deductions = ${computedNet.toFixed(2)}, but net pay is ${totals.net.toFixed(2)} (diff ${diff.toFixed(2)}). Re-process the payroll run before posting.`,
    );
  }

  // Build entries
  const entries = [
    {
      ledgerId: salariesLedger._id,
      ledgerName: salariesLedger.name,
      groupName: salariesLedger.groupName,
      type: "Dr",
      amount: totals.gross,
    },
  ];
  if (totals.pf > 0)
    entries.push({
      ledgerId: pfPayable._id,
      ledgerName: pfPayable.name,
      groupName: pfPayable.groupName,
      type: "Cr",
      amount: totals.pf,
    });
  if (totals.esi > 0)
    entries.push({
      ledgerId: esiPayable._id,
      ledgerName: esiPayable.name,
      groupName: esiPayable.groupName,
      type: "Cr",
      amount: totals.esi,
    });
  if (totals.tdsOther > 0)
    entries.push({
      ledgerId: otherDeductionsPayable._id,
      ledgerName: otherDeductionsPayable.name,
      groupName: otherDeductionsPayable.groupName,
      type: "Cr",
      amount: totals.tdsOther,
    });
  if (totals.net > 0)
    entries.push({
      ledgerId: salaryPayable._id,
      ledgerName: salaryPayable.name,
      groupName: salaryPayable.groupName,
      type: "Cr",
      amount: totals.net,
    });

  // Voucher date — last day of the payroll's pay period
  const voucherDate = new Date(run.year, run.month, 0); // month is 1-12; this gives last day of that month

  return {
    entries,
    totals,
    voucherDate,
    ledgerIds: {
      salariesLedger,
      pfPayable,
      esiPayable,
      otherDeductionsPayable,
      salaryPayable,
    },
  };
}

// ── GET /payroll/runs/:runId/preview ──────────────────────────────────────
router.get("/payroll/runs/:runId/preview", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    const HR = loadPayrollModels();
    if (!HR)
      return res
        .status(400)
        .json({ success: false, message: "HR/Payroll module not available." });

    const run = await HR.Payroll.findById(req.params.runId).lean();
    if (!run)
      return res
        .status(404)
        .json({ success: false, message: "Payroll run not found" });

    const items = await HR.PayrollItem.find({
      payrollId: req.params.runId,
    }).lean();
    if (items.length === 0)
      return res
        .status(400)
        .json({ success: false, message: "Payroll run has no items to post." });

    const built = await buildPayrollVoucher(companyId, run, items);
    res.json({
      success: true,
      run: {
        _id: run._id,
        payPeriod: run.payPeriod,
        year: run.year,
        month: run.month,
        status: run.status,
        totalEmployees: items.length,
      },
      preview: {
        voucherType: "journal",
        voucherDate: built.voucherDate,
        narration: `Salary for ${run.payPeriod || `${run.year}-${run.month}`} — ${items.length} employees`,
        entries: built.entries,
        totals: built.totals,
      },
    });
  } catch (err) {
    console.error("Payroll preview:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /payroll/runs/:runId/post ────────────────────────────────────────
router.post("/payroll/runs/:runId/post", async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const HR = loadPayrollModels();
    if (!HR)
      return res
        .status(400)
        .json({ success: false, message: "HR/Payroll module not available." });

    // Idempotency check
    const existing = await TallyVoucher.findOne({
      companyId,
      sourceSystem: "auto_from_payroll",
      sourceId: req.params.runId,
    }).lean();
    if (existing) {
      return res.json({
        success: true,
        alreadyPosted: true,
        voucher: existing,
      });
    }

    const run = await HR.Payroll.findById(req.params.runId).lean();
    if (!run)
      return res
        .status(404)
        .json({ success: false, message: "Payroll run not found" });

    const items = await HR.PayrollItem.find({
      payrollId: req.params.runId,
    }).lean();
    if (items.length === 0)
      return res
        .status(400)
        .json({ success: false, message: "Payroll run has no items to post." });

    const built = await buildPayrollVoucher(companyId, run, items);

    // Get next voucher number for type "journal"
    const voucherNumber = await TallyVoucher.nextVoucherNumber(
      companyId,
      "journal",
    );

    const voucher = await TallyVoucher.create({
      companyId,
      voucherType: "journal",
      voucherTypeName: "Journal",
      voucherNumber,
      voucherDate: built.voucherDate,
      ledgerEntries: built.entries,
      grandTotal: built.totals.gross,
      narration: `Salary for ${run.payPeriod || `${run.year}-${run.month}`} — ${items.length} employees`,
      status: "posted",
      sourceSystem: "auto_from_payroll",
      sourceId: req.params.runId,
      sourceReference: `Payroll/${run.payPeriod || `${run.year}-${run.month}`}`,
      postedAt: new Date(),
    });

    // Update ledger currentBalance for each affected ledger
    for (const entry of built.entries) {
      const signed = entry.type === "Dr" ? entry.amount : -entry.amount;
      await TallyLedger.findByIdAndUpdate(entry.ledgerId, {
        $inc: { currentBalance: signed },
      });
    }

    res.json({
      success: true,
      voucher,
      alreadyPosted: false,
      message: `Posted voucher ${voucherNumber}`,
    });
  } catch (err) {
    console.error("Post payroll:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /payroll/runs/post-all — post every unposted run for a company ──
router.post("/payroll/runs/post-all", async (req, res) => {
  try {
    const { companyId, year } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const HR = loadPayrollModels();
    if (!HR)
      return res
        .status(400)
        .json({ success: false, message: "HR/Payroll module not available." });

    const filter = {};
    if (year) filter.year = parseInt(year);
    const runs = await HR.Payroll.find(filter)
      .sort({ year: 1, month: 1 })
      .lean();

    const runIds = runs.map((r) => r._id);
    const alreadyPostedIds = new Set(
      (
        await TallyVoucher.find({
          companyId,
          sourceSystem: "auto_from_payroll",
          sourceId: { $in: runIds },
        })
          .select("sourceId")
          .lean()
      ).map((v) => String(v.sourceId)),
    );

    const results = [];
    for (const run of runs) {
      if (alreadyPostedIds.has(String(run._id))) {
        results.push({
          runId: run._id,
          payPeriod: run.payPeriod,
          status: "already_posted",
        });
        continue;
      }
      try {
        const items = await HR.PayrollItem.find({ payrollId: run._id }).lean();
        if (items.length === 0) {
          results.push({
            runId: run._id,
            payPeriod: run.payPeriod,
            status: "skipped_empty",
          });
          continue;
        }
        const built = await buildPayrollVoucher(companyId, run, items);
        const voucherNumber = await TallyVoucher.nextVoucherNumber(
          companyId,
          "journal",
        );
        const voucher = await TallyVoucher.create({
          companyId,
          voucherType: "journal",
          voucherTypeName: "Journal",
          voucherNumber,
          voucherDate: built.voucherDate,
          ledgerEntries: built.entries,
          grandTotal: built.totals.gross,
          narration: `Salary for ${run.payPeriod || `${run.year}-${run.month}`} — ${items.length} employees`,
          status: "posted",
          sourceSystem: "auto_from_payroll",
          sourceId: run._id,
          sourceReference: `Payroll/${run.payPeriod || `${run.year}-${run.month}`}`,
          postedAt: new Date(),
        });
        for (const entry of built.entries) {
          const signed = entry.type === "Dr" ? entry.amount : -entry.amount;
          await TallyLedger.findByIdAndUpdate(entry.ledgerId, {
            $inc: { currentBalance: signed },
          });
        }
        results.push({
          runId: run._id,
          payPeriod: run.payPeriod,
          status: "posted",
          voucherNumber,
        });
      } catch (e) {
        results.push({
          runId: run._id,
          payPeriod: run.payPeriod,
          status: "error",
          error: e.message,
        });
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: results.length,
        posted: results.filter((r) => r.status === "posted").length,
        alreadyPosted: results.filter((r) => r.status === "already_posted")
          .length,
        skipped: results.filter((r) => r.status === "skipped_empty").length,
        errored: results.filter((r) => r.status === "error").length,
      },
    });
  } catch (err) {
    console.error("Post all payroll:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /payroll/runs/:runId/unpost — void the auto-created voucher ──────
router.post("/payroll/runs/:runId/unpost", async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const voucher = await TallyVoucher.findOne({
      companyId,
      sourceSystem: "auto_from_payroll",
      sourceId: req.params.runId,
    });
    if (!voucher)
      return res
        .status(404)
        .json({
          success: false,
          message: "No posted voucher found for this run.",
        });

    // Reverse the ledger balances
    for (const entry of voucher.ledgerEntries) {
      const signed = entry.type === "Dr" ? -entry.amount : entry.amount;
      await TallyLedger.findByIdAndUpdate(entry.ledgerId, {
        $inc: { currentBalance: signed },
      });
    }

    voucher.status = "cancelled";
    voucher.cancelledAt = new Date();
    voucher.cancellationReason =
      req.body.reason || "Unposted via payroll → ledger UI";
    await voucher.save();

    res.json({
      success: true,
      message: `Voucher ${voucher.voucherNumber} cancelled`,
      voucher,
    });
  } catch (err) {
    console.error("Unpost payroll:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
