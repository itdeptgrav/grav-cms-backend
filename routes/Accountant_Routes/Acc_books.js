/**
 * Tally Reports Routes
 * Trial Balance, Day Book, P&L, Balance Sheet, GST Summary, Cash Flow
 * All reports respect company scope and date range.
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const auth = accountantAuth;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function parseDateRange(req) {
  const { dateFrom, dateTo } = req.query;
  return {
    from: dateFrom ? new Date(dateFrom) : null,
    to: dateTo ? new Date(dateTo) : null,
  };
}

function nestGroups(groups) {
  const byId = {};
  groups.forEach((g) => {
    byId[g._id.toString()] = { ...g, children: [], ledgers: [] };
  });
  const roots = [];
  Object.values(byId).forEach((g) => {
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
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);

    // Pull groups & ledgers
    const groups = await Acc_Group.find({
      companyId: cId,
      isActive: true,
    }).lean();
    const ledgers = await Acc_Ledger.find({
      companyId: cId,
      isActive: true,
    }).lean();

    // Aggregate posted voucher entries per ledger within range
    const matchVoucher = { companyId: cId, status: "posted" };
    if (from || to) {
      matchVoucher.voucherDate = {};
      if (from) matchVoucher.voucherDate.$gte = from;
      if (to) matchVoucher.voucherDate.$lte = to;
    }

    const movements = await Acc_Voucher.aggregate([
      { $match: matchVoucher },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          debitTotal: {
            $sum: {
              $cond: [
                // Schema field is `type` (Dr/Cr). `entryType` never
                // existed, so imported-voucher movements summed to zero
                // here too. Use the correct field.
                { $eq: ["$ledgerEntries.type", "Dr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
          creditTotal: {
            $sum: {
              $cond: [
                { $eq: ["$ledgerEntries.type", "Cr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const movementMap = {};
    movements.forEach((m) => {
      if (m && m._id) movementMap[m._id.toString()] = m;
    });

    // For opening balance: if `from` is given, opening = current - movements_within_range
    // Simpler: opening = ledger.openingBalance (as configured at start of books)
    //          plus all movement BEFORE `from` if `from` is set.
    let priorMovements = [];
    if (from) {
      priorMovements = await Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherDate: { $lt: from },
          },
        },
        { $unwind: "$ledgerEntries" },
        {
          $group: {
            _id: "$ledgerEntries.ledgerId",
            net: { $sum: "$ledgerEntries.signedAmount" },
          },
        },
      ]);
    }
    const priorMap = {};
    priorMovements.forEach((p) => {
      if (p && p._id) priorMap[p._id.toString()] = p.net;
    });

    // Build ledger rows
    const ledgerRows = ledgers.map((led) => {
      const lid = led._id.toString();
      const mv = movementMap[lid] || { debitTotal: 0, creditTotal: 0 };
      const netMove = mv.debitTotal - mv.creditTotal;

      let opening, closing;
      if (led.balanceFromTrialBalance === true && !from) {
        // TB-sourced closing. Back-derive the opening.
        closing = led.openingBalance || 0;
        opening = closing - netMove;
      } else {
        opening = (led.openingBalance || 0) + (priorMap[lid] || 0);
        closing = opening + netMove;
      }

      return {
        ledgerId: led._id,
        ledgerName: led.name,
        groupId: led.groupId,
        groupName: led.groupName,
        opening,
        debit: mv.debitTotal,
        credit: mv.creditTotal,
        closing,
        closingType: closing >= 0 ? "Dr" : "Cr",
      };
    });

    // Group ledgers under groups (flat for trial balance — Tally style)
    const groupBuckets = {};
    ledgerRows.forEach((row) => {
      const gid = row.groupId?.toString() || "ungrouped";
      if (!groupBuckets[gid])
        groupBuckets[gid] = { ledgers: [], debit: 0, credit: 0 };
      groupBuckets[gid].ledgers.push(row);
      groupBuckets[gid].debit += row.debit;
      groupBuckets[gid].credit += row.credit;
    });

    const groupRows = groups.map((g) => {
      const b = groupBuckets[g._id.toString()] || {
        ledgers: [],
        debit: 0,
        credit: 0,
      };
      return {
        groupId: g._id,
        groupName: g.name,
        nature: g.nature,
        parentId: g.parentId,
        debit: b.debit,
        credit: b.credit,
        ledgers: b.ledgers,
      };
    });

    const totals = ledgerRows.reduce(
      (acc, r) => {
        acc.debit += r.debit;
        acc.credit += r.credit;
        acc.openingDr += r.opening > 0 ? r.opening : 0;
        acc.openingCr += r.opening < 0 ? -r.opening : 0;
        acc.closingDr += r.closing > 0 ? r.closing : 0;
        acc.closingCr += r.closing < 0 ? -r.closing : 0;
        return acc;
      },
      {
        debit: 0,
        credit: 0,
        openingDr: 0,
        openingCr: 0,
        closingDr: 0,
        closingCr: 0,
      },
    );

    res.json({
      companyId,
      dateRange: { from, to },
      groups: groupRows,
      ledgers: ledgerRows,
      totals,
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
    const {
      companyId,
      voucherType,
      status = "posted",
      date,
      page = 1,
      limit = 100,
    } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    // Two ways to scope the date: single `date=YYYY-MM-DD` (day-book
    // semantics — one day's vouchers), or `dateFrom/dateTo` (range
    // semantics — kept for callers that want a window).
    const { from, to } = parseDateRange(req);

    const filter = { companyId, status };
    if (voucherType) filter.voucherType = voucherType;
    if (date) {
      const d = new Date(date);
      const dayStart = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        0,
        0,
        0,
        0,
      );
      const dayEnd = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        23,
        59,
        59,
        999,
      );
      filter.voucherDate = { $gte: dayStart, $lte: dayEnd };
    } else if (from || to) {
      filter.voucherDate = {};
      if (from) filter.voucherDate.$gte = from;
      if (to) filter.voucherDate.$lte = to;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [vouchers, total] = await Promise.all([
      Acc_Voucher.find(filter)
        // Schema field is `partyLedgerId`, not `partyLedger`. The voucher
        // already has `partyLedgerName` denormalised so we don't strictly
        // need the populate — but keeping it for callers who want the
        // full ledger doc, with the corrected field name.
        .populate("partyLedgerId", "name")
        .sort({ voucherDate: 1, createdAt: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Acc_Voucher.countDocuments(filter),
    ]);

    const totals = await Acc_Voucher.aggregate([
      {
        $match: {
          ...filter,
          companyId: new mongoose.Types.ObjectId(companyId),
        },
      },
      {
        $group: {
          _id: null,
          debit: { $sum: "$totalDebit" },
          credit: { $sum: "$totalCredit" },
        },
      },
    ]);

    res.json({
      // Day Book page expects `vouchers`; CoA / other callers also use
      // `items`. Return both for compatibility.
      vouchers,
      items: vouchers,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
      totals: totals[0] || { debit: 0, credit: 0 },
    });
  } catch (e) {
    console.error("[day-book] FAILED:", e);
    res.status(500).json({ error: e.message, stack: e.stack });
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
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);
    const groups = await Acc_Group.find({
      companyId: cId,
      isActive: true,
    }).lean();
    const ledgers = await Acc_Ledger.find({
      companyId: cId,
      isActive: true,
    }).lean();

    const groupMap = {};
    groups.forEach((g) => {
      groupMap[g._id.toString()] = g;
    });

    const matchVoucher = { companyId: cId, status: "posted" };
    if (from || to) {
      matchVoucher.voucherDate = {};
      if (from) matchVoucher.voucherDate.$gte = from;
      if (to) matchVoucher.voucherDate.$lte = to;
    }

    const movements = await Acc_Voucher.aggregate([
      { $match: matchVoucher },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          net: { $sum: "$ledgerEntries.signedAmount" },
        },
      },
    ]);
    const moveMap = {};
    movements.forEach((m) => {
      if (m && m._id) moveMap[m._id.toString()] = m.net;
    });

    const revenueLines = [];
    const expenseLines = [];

    ledgers.forEach((led) => {
      const grp = groupMap[led.groupId?.toString()];
      if (!grp) return;
      const net = moveMap[led._id.toString()] || 0;
      // Revenue: credit balance is income → -net (since signed is Dr-positive)
      // Acc_Expense: debit balance is expense → +net
      const line = {
        ledgerId: led._id,
        ledgerName: led.name,
        groupName: led.groupName,
      };
      // Optional drag-and-drop fields (added Apr 2026). Wrapped so legacy
      // ledgers without them never crash the route.
      try {
        line.groupId = led.groupId || null;
        line.groupOrder = led.groupOrder === undefined ? null : led.groupOrder;
      } catch (_) {
        /* defensive */
      }

      if (grp.nature === "revenue") {
        revenueLines.push({ ...line, amount: -net }); // credit-side gives income
      } else if (grp.nature === "expense") {
        expenseLines.push({ ...line, amount: net }); // debit-side gives expense
      }
    });

    // Sort each side by user-set groupOrder, then alphabetically. Same
    // pattern as Balance Sheet. Wrapped so a bad comparator can't kill
    // the response.
    try {
      function sortByOrder(arr) {
        arr.sort((a, b) => {
          const ao = a.groupOrder,
            bo = b.groupOrder;
          if (ao != null && bo == null) return -1;
          if (ao == null && bo != null) return 1;
          if (ao != null && bo != null && ao !== bo) return ao - bo;
          return (a.ledgerName || "").localeCompare(b.ledgerName || "");
        });
      }
      sortByOrder(revenueLines);
      sortByOrder(expenseLines);
    } catch (sortErr) {
      console.warn("[profit-loss] sort skipped:", sortErr.message);
    }

    const totalRevenue = revenueLines.reduce((s, l) => s + l.amount, 0);
    const totalExpense = expenseLines.reduce((s, l) => s + l.amount, 0);
    const netProfit = totalRevenue - totalExpense;

    // Group sub-totals
    const groupSummary = (lines) => {
      const map = {};
      lines.forEach((l) => {
        map[l.groupName] = (map[l.groupName] || 0) + l.amount;
      });
      return Object.entries(map).map(([groupName, amount]) => ({
        groupName,
        amount,
      }));
    };

    res.json({
      companyId,
      dateRange: { from, to },
      revenue: {
        lines: revenueLines,
        byGroup: groupSummary(revenueLines),
        total: totalRevenue,
      },
      expense: {
        lines: expenseLines,
        byGroup: groupSummary(expenseLines),
        total: totalExpense,
      },
      netProfit,
    });
  } catch (e) {
    console.error("[profit-loss] FAILED:", e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

/* ------------------------------------------------------------------ */
/* BALANCE SHEET                                                       */
/* ------------------------------------------------------------------ */
/*
 * As-of date snapshot: for each ledger compute closing balance =
 * openingBalance + sum of signedAmount across all postings up to date.
 * Group by nature: assets / liabilities / equity.
 */
router.get("/balance-sheet", auth, async (req, res) => {
  try {
    const { companyId, asOf, from } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const asOfDate = asOf ? new Date(asOf) : new Date();
    // Optional period start. A Balance Sheet is fundamentally an
    // "as at <date>" snapshot, but the accountant asked to also bound
    // the start so they can view a specific period's closing position
    // (movements from `from` … `asOf`, opening balances still included
    // as the brought-forward position). When `from` is omitted it's the
    // classic cumulative-to-date balance sheet.
    const fromDate = from ? new Date(from) : null;

    const cId = new mongoose.Types.ObjectId(companyId);
    const groups = await Acc_Group.find({
      companyId: cId,
      isActive: true,
    }).lean();
    const ledgers = await Acc_Ledger.find({
      companyId: cId,
      isActive: true,
    }).lean();

    const groupMap = {};
    groups.forEach((g) => {
      groupMap[g._id.toString()] = g;
    });

    // ── Tally primary group resolution ──────────────────────────────
    // Walk each group's parent chain to find the top-level Tally group
    // (e.g. "Current Liabilities" instead of "Sundry Creditors").
    const groupNameMap = {};
    groups.forEach((g) => {
      if (g.name) groupNameMap[g.name.toLowerCase()] = g;
    });
    function findPrimary(grp) {
      if (!grp) return null;
      const visited = new Set();
      let cur = grp;
      while (cur) {
        const cid = cur._id?.toString();
        if (visited.has(cid)) break;
        visited.add(cid);
        if (!cur.parent && !cur.parentName) return cur;
        const parent = cur.parent ? groupMap[cur.parent.toString()] : null;
        if (parent) {
          cur = parent;
          continue;
        }
        const byName = cur.parentName
          ? groupNameMap[cur.parentName.toLowerCase()]
          : null;
        if (byName) {
          cur = byName;
          continue;
        }
        return cur;
      }
      return cur || grp;
    }
    const _primaryCache = {};
    function getPrimaryGroupName(grp) {
      if (!grp) return "";
      const gid = grp._id?.toString();
      if (_primaryCache[gid] !== undefined) return _primaryCache[gid];
      const prim = findPrimary(grp);
      const name = prim?.name || grp.name || "";
      _primaryCache[gid] = name;
      return name;
    }

    const voucherMatch = {
      companyId: cId,
      status: "posted",
      voucherDate: { $lte: asOfDate },
    };
    if (fromDate) voucherMatch.voucherDate.$gte = fromDate;

    const movements = await Acc_Voucher.aggregate([
      { $match: voucherMatch },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          net: { $sum: "$ledgerEntries.signedAmount" },
        },
      },
    ]);
    const moveMap = {};
    movements.forEach((m) => {
      if (m && m._id) moveMap[m._id.toString()] = m.net;
    });

    // Compute net profit (revenue - expense) up to asOf and add to equity
    let revenueNet = 0,
      expenseNet = 0;
    const buckets = { asset: [], liability: [], equity: [] };

    // ── Tally reserved group → nature override ──────────────────────
    // If a group was manually created or imported with the wrong nature
    // (e.g. Capital Account → "liability"), this corrects it at query
    // time so the BS groups correctly without requiring a re-import.
    const TALLY_NATURE = {
      "capital account": "equity",
      "reserves & surplus": "equity",
      "current liabilities": "liability",
      "loans (liability)": "liability",
      "secured loans": "liability",
      "unsecured loans": "liability",
      "bank od a/c": "liability",
      provisions: "liability",
      "current assets": "asset",
      "fixed assets": "asset",
      investments: "asset",
      "misc. expenses (asset)": "asset",
      "branch / divisions": "asset",
      "suspense a/c": "liability",
      "stock-in-hand": "asset",
      "sundry creditors": "liability",
      "sundry debtors": "asset",
      "bank accounts": "asset",
      "cash-in-hand": "asset",
      "deposits (asset)": "asset",
      "loans & advances (asset)": "asset",
      "duties & taxes": "liability",
      "sales accounts": "revenue",
      "purchase accounts": "expense",
      "direct expenses": "expense",
      "indirect expenses": "expense",
      "direct incomes": "revenue",
      "indirect incomes": "revenue",
    };

    ledgers.forEach((led) => {
      const grp = groupMap[led.groupId?.toString()];
      if (!grp) return;

      // Resolve nature: DB value, then Tally override
      const grpNameLower = String(grp.name || "")
        .trim()
        .toLowerCase();
      const nature = TALLY_NATURE[grpNameLower] || grp.nature;

      const lname = String(led.name || "")
        .trim()
        .toLowerCase();
      if (
        led.isReserved === true ||
        lname === "profit & loss a/c" ||
        lname === "profit and loss a/c"
      ) {
        return;
      }

      // BALANCE: TB-flagged → stored closing. Otherwise → opening + moves.
      const closing =
        led.balanceFromTrialBalance === true
          ? led.openingBalance || 0
          : (led.openingBalance || 0) + (moveMap[led._id.toString()] || 0);

      const primaryName = getPrimaryGroupName(grp);
      const line = {
        ledgerId: led._id,
        ledgerName: led.name,
        // Set groupName to Tally PRIMARY group so the frontend groups
        // like Tally does (e.g. all Sundry Creditors, Duties & Taxes
        // etc. collapse under "Current Liabilities" with one total).
        groupName: primaryName || led.groupName,
        subGroupName: led.groupName,
        amount: closing,
        displayAmount: Math.abs(closing),
        signedAmount: closing,
      };
      try {
        line.groupId = led.groupId || null;
        line.groupOrder = led.groupOrder === undefined ? null : led.groupOrder;
      } catch (fieldErr) {
        console.warn("[balance-sheet] new fields skipped:", fieldErr.message);
      }
      if (nature === "asset") buckets.asset.push(line);
      else if (nature === "liability") buckets.liability.push(line);
      else if (nature === "equity") buckets.equity.push(line);
      else if (nature === "revenue") revenueNet += -closing;
      else if (nature === "expense") expenseNet += closing;
    });

    // Sort each bucket by user-set groupOrder, then alphabetically. Wrapped
    // in try so any sort comparator error doesn't kill the whole response.
    try {
      function bucketSort(arr) {
        arr.sort((a, b) => {
          const ao = a.groupOrder,
            bo = b.groupOrder;
          if (ao != null && bo == null) return -1;
          if (ao == null && bo != null) return 1;
          if (ao != null && bo != null && ao !== bo) return ao - bo;
          return (a.ledgerName || "").localeCompare(b.ledgerName || "");
        });
      }
      bucketSort(buckets.asset);
      bucketSort(buckets.liability);
      bucketSort(buckets.equity);
    } catch (sortErr) {
      console.warn("[balance-sheet] sort skipped:", sortErr.message);
    }

    // ── Correct Balance-Sheet assembly ──────────────────────────────
    // Every `line.amount` is Tally-signed: Debit +, Credit −.
    //   • Assets are naturally Debit  → presented as  +Σ(signed)
    //   • Liabilities/Equity are Cr   → presented as  −Σ(signed)  (so a
    //     normal credit balance shows as a positive figure)
    //   • Current-year P&L: a LOSS is shown on the ASSETS side (exactly
    //     like Tally), a PROFIT on the equity side. This placement is the
    //     piece that was missing/!wrong before and caused the false
    //     "OUT OF BALANCE".
    const netProfit = revenueNet - expenseNet; // <0 = loss, >0 = profit

    const rawAssets = buckets.asset.reduce((s, x) => s + x.amount, 0); // Dr+
    const rawLiab = buckets.liability.reduce((s, x) => s + x.amount, 0); // signed
    const rawEquity = buckets.equity.reduce((s, x) => s + x.amount, 0); // signed

    // Present liabilities & equity as positive credit figures.
    const liabilitiesTotal = -rawLiab;
    let equityTotal = -rawEquity;

    // Assets side carries any current-period LOSS (Tally convention).
    let assetsTotal = rawAssets;
    if (netProfit < 0) {
      assetsTotal += Math.abs(netProfit);
      buckets.asset.push({
        ledgerName: "Profit & Loss A/c (Current Period Loss)",
        groupName: "Profit & Loss A/c",
        amount: Math.abs(netProfit), // Dr on assets side
        displayAmount: Math.abs(netProfit),
        signedAmount: Math.abs(netProfit),
        synthetic: true,
      });
    } else if (netProfit > 0) {
      equityTotal += netProfit;
      buckets.equity.push({
        ledgerName: "Net Profit (Current Period)",
        groupName: "Profit & Loss",
        amount: -netProfit, // Cr in equity
        displayAmount: netProfit,
        signedAmount: -netProfit,
        synthetic: true,
      });
    }

    const liabEquityTotal = liabilitiesTotal + equityTotal;

    // ── Tally-style primary group aggregation ───────────────────────
    // Walk up the group parent chain to find each group's PRIMARY
    // (root) group, then aggregate ledger balances by primary group.
    // This produces the same view Tally shows: "Current Liabilities
    // ₹23,40,507" instead of showing each sub-group separately.
    function findPrimary(grpId) {
      let g = groupMap[grpId?.toString()];
      if (!g) return null;
      let depth = 0;
      while (depth < 10) {
        const pid = g.parentId || g.parent;
        if (!pid) break;
        const parent = groupMap[pid.toString()];
        if (!parent) break;
        g = parent;
        depth++;
      }
      return g;
    }
    function buildPrimaryGroups(lines) {
      const map = {};
      for (const ln of lines) {
        const primary = findPrimary(ln.groupId);
        const pName = primary ? primary.name : ln.groupName || "Other";
        if (!map[pName]) {
          map[pName] = {
            groupName: pName,
            total: 0,
            ledgerCount: 0,
            subGroups: {},
          };
        }
        map[pName].total += ln.amount || 0;
        map[pName].ledgerCount++;
        const sg = ln.groupName || "Other";
        if (!map[pName].subGroups[sg]) {
          map[pName].subGroups[sg] = {
            groupName: sg,
            total: 0,
            ledgerCount: 0,
          };
        }
        map[pName].subGroups[sg].total += ln.amount || 0;
        map[pName].subGroups[sg].ledgerCount++;
      }
      return Object.values(map)
        .map((pg) => ({
          ...pg,
          displayTotal: Math.abs(pg.total),
          subGroups: Object.values(pg.subGroups).sort(
            (a, b) => Math.abs(b.total) - Math.abs(a.total),
          ),
        }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    }

    // Per-line Dr/Cr
    function applyDrCr(arr) {
      for (const ln of arr) {
        const v = ln.amount || 0;
        ln.debit = v > 0 ? v : 0;
        ln.credit = v < 0 ? -v : 0;
        if (ln.displayAmount == null) ln.displayAmount = Math.abs(v);
      }
    }
    applyDrCr(buckets.asset);
    applyDrCr(buckets.liability);
    applyDrCr(buckets.equity);

    const sumDr = (arr) => arr.reduce((s, x) => s + (x.debit || 0), 0);
    const sumCr = (arr) => arr.reduce((s, x) => s + (x.credit || 0), 0);
    const difference = assetsTotal - liabEquityTotal;

    const sectionNet = (arr) => sumDr(arr) - sumCr(arr);

    res.json({
      companyId,
      asOf: asOfDate,
      assets: {
        lines: buckets.asset,
        groups: buildPrimaryGroups(buckets.asset),
        total: assetsTotal,
        debit: sumDr(buckets.asset),
        credit: sumCr(buckets.asset),
        net: sectionNet(buckets.asset),
      },
      liabilities: {
        lines: buckets.liability,
        groups: buildPrimaryGroups(buckets.liability),
        total: liabilitiesTotal,
        debit: sumDr(buckets.liability),
        credit: sumCr(buckets.liability),
        net: sectionNet(buckets.liability),
      },
      equity: {
        lines: buckets.equity,
        groups: buildPrimaryGroups(buckets.equity),
        total: equityTotal,
        debit: sumDr(buckets.equity),
        credit: sumCr(buckets.equity),
        net: sectionNet(buckets.equity),
      },
      netProfit,
      check: {
        assetsTotal,
        liabEquityTotal,
        difference,
        isBalanced: Math.abs(difference) < 1,
      },
    });
  } catch (e) {
    // Log full stack trace so the actual cause shows in your terminal —
    // previously this was a bare `e.message` which hid the real error.
    console.error("[balance-sheet] FAILED:", e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

/* ------------------------------------------------------------------ */
/* GST SUMMARY (GSTR-1 / GSTR-3B style)                                */
/* ------------------------------------------------------------------ */
router.get("/gst-summary", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);
    const match = { companyId: cId, status: "posted" };
    if (from || to) {
      match.voucherDate = {};
      if (from) match.voucherDate.$gte = from;
      if (to) match.voucherDate.$lte = to;
    }

    // Outward (Sales + Credit Notes against)
    const outward = await Acc_Voucher.aggregate([
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
          grandTotal: { $sum: "$grandTotal" },
        },
      },
    ]);

    // Inward (Purchase + Debit Notes against)
    const inward = await Acc_Voucher.aggregate([
      {
        $match: { ...match, voucherType: { $in: ["purchase", "debit_note"] } },
      },
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
          grandTotal: { $sum: "$grandTotal" },
        },
      },
    ]);

    const sumGroup = (arr) =>
      arr.reduce(
        (acc, r) => {
          acc.count += r.count;
          acc.taxable += r.taxable || 0;
          acc.cgst += r.cgst || 0;
          acc.sgst += r.sgst || 0;
          acc.igst += r.igst || 0;
          acc.cess += r.cess || 0;
          acc.total += r.total || 0;
          acc.grandTotal += r.grandTotal || 0;
          return acc;
        },
        {
          count: 0,
          taxable: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
          cess: 0,
          total: 0,
          grandTotal: 0,
        },
      );

    const outwardTotals = sumGroup(outward);
    const inwardTotals = sumGroup(inward);

    // ── Fallback: derive GST from ledger entries ───────────────────────
    // Imported Tally vouchers (Day Book / B-Sheet) do NOT carry a
    // `gstBreakup` object — only raw ledgerEntries — so the aggregation
    // above returns all-zeros for imported data and the GST report looked
    // empty. When the breakup totals are empty, reconstruct CGST/SGST/
    // IGST/cess from the GST ledger lines by name pattern:
    //   • "Output ..." / "... Payable" → outward (sales) tax
    //   • "Input ..."                  → inward (purchase) ITC
    function classifyGst(name) {
      const n = String(name || "").toLowerCase();
      if (!/gst|cess/.test(n)) return null;
      let comp = null;
      if (/cess/.test(n)) comp = "cess";
      else if (/igst/.test(n)) comp = "igst";
      else if (/cgst/.test(n)) comp = "cgst";
      else if (/sgst|utgst/.test(n)) comp = "sgst";
      if (!comp) return null;
      const dir = /input/.test(n)
        ? "inward"
        : /output|payable/.test(n)
          ? "outward"
          : null;
      return { comp, dir };
    }

    const breakupEmpty =
      outwardTotals.cgst +
        outwardTotals.sgst +
        outwardTotals.igst +
        outwardTotals.cess +
        inwardTotals.cgst +
        inwardTotals.sgst +
        inwardTotals.igst +
        inwardTotals.cess ===
      0;

    if (breakupEmpty) {
      const vouchers = await Acc_Voucher.find(match)
        .select("voucherType ledgerEntries")
        .lean();
      for (const v of vouchers) {
        for (const e of v.ledgerEntries || []) {
          const c = classifyGst(e.ledgerName);
          if (!c) continue;
          const amt = Math.abs(e.amount || 0);
          if (amt === 0) continue;
          let dir = c.dir;
          if (!dir)
            dir = ["sales", "credit_note"].includes(v.voucherType)
              ? "outward"
              : "inward";
          const bucket = dir === "outward" ? outwardTotals : inwardTotals;
          bucket[c.comp] += amt;
          bucket.total += amt;
        }
      }
      const grossOut = await Acc_Voucher.aggregate([
        {
          $match: {
            ...match,
            voucherType: { $in: ["sales", "credit_note"] },
          },
        },
        { $group: { _id: null, g: { $sum: "$grandTotal" } } },
      ]);
      const grossIn = await Acc_Voucher.aggregate([
        {
          $match: {
            ...match,
            voucherType: { $in: ["purchase", "debit_note"] },
          },
        },
        { $group: { _id: null, g: { $sum: "$grandTotal" } } },
      ]);
      outwardTotals.grandTotal = grossOut[0]?.g || 0;
      inwardTotals.grandTotal = grossIn[0]?.g || 0;
      outwardTotals.taxable =
        outwardTotals.grandTotal -
        (outwardTotals.cgst +
          outwardTotals.sgst +
          outwardTotals.igst +
          outwardTotals.cess);
      inwardTotals.taxable =
        inwardTotals.grandTotal -
        (inwardTotals.cgst +
          inwardTotals.sgst +
          inwardTotals.igst +
          inwardTotals.cess);
      outwardTotals.derivedFromLedgers = true;
      inwardTotals.derivedFromLedgers = true;
    }

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
        total:
          outwardTotals.cgst +
          outwardTotals.sgst +
          outwardTotals.igst +
          outwardTotals.cess -
          (inwardTotals.cgst +
            inwardTotals.sgst +
            inwardTotals.igst +
            inwardTotals.cess),
      },
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
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const { from, to } = parseDateRange(req);

    const cId = new mongoose.Types.ObjectId(companyId);
    // Find cash & bank ledgers — Tally groups: "Cash-in-Hand", "Bank Accounts"
    const cashGroups = await Acc_Group.find({
      companyId: cId,
      name: { $in: ["Cash-in-Hand", "Bank Accounts", "Bank OD A/c"] },
    })
      .select("_id")
      .lean();
    const cashGroupIds = cashGroups.map((g) => g._id);
    const cashLedgers = await Acc_Ledger.find({
      companyId: cId,
      groupId: { $in: cashGroupIds },
    }).lean();
    const cashLedgerIds = cashLedgers.map((l) => l._id);

    const match = {
      companyId: cId,
      status: "posted",
      "ledgerEntries.ledgerId": { $in: cashLedgerIds },
    };
    if (from || to) {
      match.voucherDate = {};
      if (from) match.voucherDate.$gte = from;
      if (to) match.voucherDate.$lte = to;
    }

    const flows = await Acc_Voucher.aggregate([
      { $match: match },
      { $unwind: "$ledgerEntries" },
      { $match: { "ledgerEntries.ledgerId": { $in: cashLedgerIds } } },
      {
        $group: {
          _id: { ledger: "$ledgerEntries.ledgerId", type: "$voucherType" },
          inflow: {
            $sum: {
              $cond: [
                // Schema field is `type` (enum Dr/Cr). The old code keyed
                // off `entryType`, which does not exist on any voucher —
                // so cash flow always summed to 0 and showed no data.
                // Cash/bank DEBIT = money in (inflow).
                { $eq: ["$ledgerEntries.type", "Dr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
          outflow: {
            $sum: {
              $cond: [
                { $eq: ["$ledgerEntries.type", "Cr"] },
                "$ledgerEntries.amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const ledMap = {};
    cashLedgers.forEach((l) => {
      ledMap[l._id.toString()] = l;
    });

    const breakdown = flows.map((f) => ({
      ledgerId: f._id.ledger,
      ledgerName: ledMap[f._id.ledger.toString()]?.name || "Unknown",
      voucherType: f._id.type,
      inflow: f.inflow,
      outflow: f.outflow,
      net: f.inflow - f.outflow,
    }));

    const totals = breakdown.reduce(
      (a, b) => {
        a.inflow += b.inflow;
        a.outflow += b.outflow;
        a.net += b.net;
        return a;
      },
      { inflow: 0, outflow: 0, net: 0 },
    );

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
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const cId = new mongoose.Types.ObjectId(companyId);

    const today = new Date();
    const thirtyAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fyStart = new Date(
      today.getFullYear(),
      today.getMonth() >= 3 ? 3 : -9,
      1,
    );

    const [
      recent30Sales,
      recent30Purchases,
      recent30Receipts,
      recent30Payments,
      fySales,
      fyPurchases,
      recentVouchers,
      ledgerCount,
    ] = await Promise.all([
      Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherType: "sales",
            voucherDate: { $gte: thirtyAgo },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$grandTotal" },
            count: { $sum: 1 },
          },
        },
      ]),
      Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherType: "purchase",
            voucherDate: { $gte: thirtyAgo },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$grandTotal" },
            count: { $sum: 1 },
          },
        },
      ]),
      Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherType: "receipt",
            voucherDate: { $gte: thirtyAgo },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalDebit" },
            count: { $sum: 1 },
          },
        },
      ]),
      Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherType: "payment",
            voucherDate: { $gte: thirtyAgo },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalCredit" },
            count: { $sum: 1 },
          },
        },
      ]),
      Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherType: "sales",
            voucherDate: { $gte: fyStart },
          },
        },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } },
      ]),
      Acc_Voucher.aggregate([
        {
          $match: {
            companyId: cId,
            status: "posted",
            voucherType: "purchase",
            voucherDate: { $gte: fyStart },
          },
        },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } },
      ]),
      Acc_Voucher.find({ companyId: cId })
        .sort("-createdAt")
        .limit(8)
        .populate("partyLedgerId", "name")
        .lean(),
      Acc_Ledger.countDocuments({ companyId: cId, isActive: true }),
    ]);

    const v = (a) => a[0]?.total || 0;
    const c = (a) => a[0]?.count || 0;

    res.json({
      last30Days: {
        sales: { total: v(recent30Sales), count: c(recent30Sales) },
        purchases: { total: v(recent30Purchases), count: c(recent30Purchases) },
        receipts: { total: v(recent30Receipts), count: c(recent30Receipts) },
        payments: { total: v(recent30Payments), count: c(recent30Payments) },
      },
      fyToDate: {
        sales: v(fySales),
        purchases: v(fyPurchases),
        gross: v(fySales) - v(fyPurchases),
      },
      ledgerCount,
      recentVouchers,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /data-range?companyId=                                          */
/* Returns the actual first/last posted-voucher dates for this company */
/* plus the financial year (Apr–Mar) that CONTAINS the data. The       */
/* report pages use this to default their date filter to where the    */
/* data actually is — otherwise a freshly-imported prior-year data set */
/* shows empty Cash Flow / GST / Balance Sheet because the UI defaulted */
/* to the calendar-current FY (which has no vouchers yet).             */
/* ------------------------------------------------------------------ */
router.get("/data-range", auth, async (req, res) => {
  try {
    let cId;
    if (req.query.companyId) {
      cId = new mongoose.Types.ObjectId(req.query.companyId);
    } else {
      // Some report pages (e.g. GST) don't carry a companyId — resolve
      // the primary/only accounting company like the other bridges do.
      let company = await Acc_Company.findOne({ isPrimary: true })
        .select("_id")
        .lean();
      if (!company) {
        const all = await Acc_Company.find({}).select("_id").limit(2).lean();
        if (all.length === 1) company = all[0];
      }
      if (!company)
        return res.json({
          hasData: false,
          minDate: null,
          maxDate: null,
          count: 0,
          fy: null,
        });
      cId = company._id;
    }

    const agg = await Acc_Voucher.aggregate([
      { $match: { companyId: cId, status: "posted" } },
      {
        $group: {
          _id: null,
          minDate: { $min: "$voucherDate" },
          maxDate: { $max: "$voucherDate" },
          count: { $sum: 1 },
        },
      },
    ]);

    if (!agg.length || !agg[0].minDate) {
      return res.json({
        hasData: false,
        minDate: null,
        maxDate: null,
        count: 0,
        fy: null,
      });
    }

    const min = new Date(agg[0].minDate);
    const max = new Date(agg[0].maxDate);
    // FY that contains the EARLIEST voucher (Indian FY: Apr 1 – Mar 31).
    const fyStartYear =
      min.getMonth() >= 3 ? min.getFullYear() : min.getFullYear() - 1;
    const fyStart = new Date(fyStartYear, 3, 1);
    const fyEnd = new Date(fyStartYear + 1, 2, 31);

    res.json({
      hasData: true,
      minDate: min.toISOString().slice(0, 10),
      maxDate: max.toISOString().slice(0, 10),
      count: agg[0].count,
      fy: {
        startYear: fyStartYear,
        label: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`,
        start: fyStart.toISOString().slice(0, 10),
        end: fyEnd.toISOString().slice(0, 10),
      },
    });
  } catch (e) {
    console.error("[data-range]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /dashboard-overview — Dashboard metrics from Acc_Voucher        */
/* ------------------------------------------------------------------ */
/* Computes all dashboard KPIs from actual voucher data (not CMS).
 * Uses voucherDate (not createdAt) for accurate period matching.
 * Accepts optional from/to date range; defaults to current Indian FY.
 *
 * Query params:
 *   companyId — required
 *   from      — ISO date (default: FY start, April 1)
 *   to        — ISO date (default: today)
 */
router.get("/dashboard-overview", auth, async (req, res) => {
  try {
    const { companyId, from, to } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const cId = new mongoose.Types.ObjectId(companyId);
    const today = new Date();

    // Default to current Indian FY (April–March)
    let fyStart = new Date(today.getFullYear(), 3, 1); // April 1
    if (today.getMonth() < 3) fyStart.setFullYear(today.getFullYear() - 1);

    const dateFrom = from ? new Date(from) : fyStart;
    const dateTo = to ? new Date(to) : today;

    // ── 1. Aggregate ALL voucher entries in date range ─────────────
    const entries = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: cId,
          status: "posted",
          voucherDate: { $gte: dateFrom, $lte: dateTo },
        },
      },
      { $unwind: "$ledgerEntries" },
      {
        $lookup: {
          from: "acc_ledgers",
          localField: "ledgerEntries.ledgerId",
          foreignField: "_id",
          as: "_led",
        },
      },
      { $unwind: { path: "$_led", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          voucherType: 1,
          voucherDate: 1,
          voucherNumber: 1,
          ledgerId: "$ledgerEntries.ledgerId",
          ledgerName: "$ledgerEntries.ledgerName",
          groupName: {
            $ifNull: ["$_led.groupName", "$ledgerEntries.groupName"],
          },
          nature: "$_led.nature",
          type: "$ledgerEntries.type",
          amount: "$ledgerEntries.amount",
          signedAmount: {
            $cond: {
              if: {
                $ne: [{ $ifNull: ["$ledgerEntries.signedAmount", null] }, null],
              },
              then: "$ledgerEntries.signedAmount",
              else: {
                $cond: {
                  if: { $eq: ["$ledgerEntries.type", "Dr"] },
                  then: { $ifNull: ["$ledgerEntries.amount", 0] },
                  else: {
                    $multiply: [{ $ifNull: ["$ledgerEntries.amount", 0] }, -1],
                  },
                },
              },
            },
          },
        },
      },
    ]);

    // ── 2. Compute KPIs from entries ──────────────────────────────
    let totalRevenue = 0,
      totalExpenses = 0;
    let totalReceivables = 0,
      totalPayables = 0;
    let salesCount = 0,
      purchaseCount = 0,
      paymentCount = 0,
      receiptCount = 0,
      journalCount = 0;
    const seenVouchers = new Set();
    const monthlyMap = {}; // "YYYY-MM" → { revenue, expenses }
    const dailyMap = {}; // "YYYY-MM-DD" → { revenue, expenses }

    // Group names that indicate revenue / expense
    const revenueGroups =
      /sales\s*account|direct\s*income|indirect\s*income|revenue/i;
    const expenseGroups =
      /direct\s*expense|indirect\s*expense|purchase\s*account|manufacturing\s*expense/i;
    const receivableGroups = /sundry\s*debtor/i;
    const payableGroups = /sundry\s*creditor/i;

    for (const e of entries) {
      const gn = e.groupName || "";
      const sa = e.signedAmount || 0;

      // Revenue (Cr to revenue accounts = negative signed, so negate)
      if (revenueGroups.test(gn)) {
        totalRevenue += Math.abs(sa);
      }
      // Expenses (Dr to expense accounts = positive signed)
      if (expenseGroups.test(gn)) {
        totalExpenses += Math.abs(sa);
      }
      // Receivables (Dr balance in Sundry Debtors)
      if (receivableGroups.test(gn) && sa > 0) {
        totalReceivables += sa;
      }
      // Payables (Cr balance in Sundry Creditors)
      if (payableGroups.test(gn) && sa < 0) {
        totalPayables += Math.abs(sa);
      }

      // Count voucher types (deduplicate by voucher _id)
      const vKey = `${e.voucherType}:${e.voucherNumber}`;
      if (!seenVouchers.has(vKey)) {
        seenVouchers.add(vKey);
        if (e.voucherType === "sales") salesCount++;
        else if (e.voucherType === "purchase") purchaseCount++;
        else if (e.voucherType === "payment") paymentCount++;
        else if (e.voucherType === "receipt") receiptCount++;
        else if (e.voucherType === "journal") journalCount++;
      }

      // Monthly trend (by voucherDate)
      const d = new Date(e.voucherDate);
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[mk]) monthlyMap[mk] = { revenue: 0, expenses: 0 };
      if (revenueGroups.test(gn)) monthlyMap[mk].revenue += Math.abs(sa);
      if (expenseGroups.test(gn)) monthlyMap[mk].expenses += Math.abs(sa);

      // Daily trend
      const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!dailyMap[dk]) dailyMap[dk] = { revenue: 0, expenses: 0 };
      if (revenueGroups.test(gn)) dailyMap[dk].revenue += Math.abs(sa);
      if (expenseGroups.test(gn)) dailyMap[dk].expenses += Math.abs(sa);
    }

    // Build sorted monthly trend array
    const monthKeys = Object.keys(monthlyMap).sort();
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const revenueTrend = monthKeys.map((mk) => {
      const [y, m] = mk.split("-");
      const data = monthlyMap[mk];
      return {
        month: `${monthNames[parseInt(m) - 1]} ${y}`,
        revenue: parseFloat(data.revenue.toFixed(2)),
        expenses: parseFloat(data.expenses.toFixed(2)),
        profit: parseFloat((data.revenue - data.expenses).toFixed(2)),
      };
    });

    // Build sorted daily trend array
    const dailyKeys = Object.keys(dailyMap).sort();
    const dailyTrend = dailyKeys.map((dk) => {
      const data = dailyMap[dk];
      const dd = new Date(dk + "T00:00:00");
      return {
        day: dk,
        label: `${dd.getDate()} ${monthNames[dd.getMonth()]}`,
        revenue: parseFloat(data.revenue.toFixed(2)),
        expenses: parseFloat(data.expenses.toFixed(2)),
        profit: parseFloat((data.revenue - data.expenses).toFixed(2)),
      };
    });

    // ── 3. Ledger/group counts ────────────────────────────────────
    const [totalLedgers, totalGroups, debtorCount, creditorCount] =
      await Promise.all([
        Acc_Ledger.countDocuments({ companyId: cId, isActive: true }),
        Acc_Group.countDocuments({ companyId: cId, isActive: true }),
        Acc_Ledger.countDocuments({
          companyId: cId,
          isActive: true,
          groupName: /sundry\s*debtor/i,
        }),
        Acc_Ledger.countDocuments({
          companyId: cId,
          isActive: true,
          groupName: /sundry\s*creditor/i,
        }),
      ]);

    // ── 4. Voucher type distribution ──────────────────────────────
    const voucherDist = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: cId,
          status: "posted",
          voucherDate: { $gte: dateFrom, $lte: dateTo },
        },
      },
      {
        $group: {
          _id: "$voucherType",
          count: { $sum: 1 },
          total: { $sum: "$grandTotal" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // ── 5. Top parties by volume ──────────────────────────────────
    const topParties = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: cId,
          status: "posted",
          voucherDate: { $gte: dateFrom, $lte: dateTo },
          partyLedgerName: { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$partyLedgerName",
          count: { $sum: 1 },
          total: { $sum: "$grandTotal" },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]);

    res.json({
      success: true,
      overview: {
        dateRange: { from: dateFrom, to: dateTo },
        financial: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),
          netProfit: parseFloat((totalRevenue - totalExpenses).toFixed(2)),
          totalReceivables: parseFloat(totalReceivables.toFixed(2)),
          totalPayables: parseFloat(totalPayables.toFixed(2)),
          cashFlow: {
            inflow: parseFloat(totalRevenue.toFixed(2)),
            outflow: parseFloat(totalExpenses.toFixed(2)),
            net: parseFloat((totalRevenue - totalExpenses).toFixed(2)),
          },
        },
        voucherCounts: {
          sales: salesCount,
          purchase: purchaseCount,
          payment: paymentCount,
          receipt: receiptCount,
          journal: journalCount,
          total: seenVouchers.size,
        },
        voucherDistribution: voucherDist,
        revenueTrend,
        dailyTrend,
        topParties,
        counts: {
          ledgers: totalLedgers,
          groups: totalGroups,
          debtors: debtorCount,
          creditors: creditorCount,
        },
      },
    });
  } catch (e) {
    console.error("[dashboard-overview]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
