// routes/Accountant_Routes/Acc_parties.js
//
// PARTIES — Vendors & Customers sourced from the IMPORTED Tally ledgers.
// ─────────────────────────────────────────────────────────────────────────────
// Problem this solves:
//   The existing Vendors page reads the CMS `Vendor` collection and the
//   Customers page reads the CRM `Customer` collection. Neither looks at
//   the ledgers created by the Tally import. So every party that came in
//   from Tally (under the "Sundry Creditors" / "Sundry Debtors" groups)
//   was invisible in Vendors/Customers, even though its ledger and all its
//   vouchers/invoices were imported correctly.
//
// This route surfaces those imported ledgers directly:
//   • Sundry Creditors  → Vendors  (we owe them)
//   • Sundry Debtors    → Customers (they owe us)
// Each party shows its real ledger balance and every transaction tied to
// that single ledger — so all of "Mayfair Kalimpong"'s invoices/receipts
// appear together under the one party, exactly as in Tally.
//
// No data duplication: we read the Acc_Ledger / Acc_Voucher records the
// import already created. Nothing is copied into the CMS Vendor or CRM
// Customer collections (which have different schemas and would re-create
// the ghost-duplicate problem).
//
// Endpoints:
//   GET /parties?companyId=&kind=vendor|customer&search=&page=&limit=
//        → list with per-party balance + txn count
//   GET /parties/:ledgerId?companyId=
//        → one party: ledger info + computed balance summary
//   GET /parties/:ledgerId/transactions?companyId=&from=&to=
//        → every posted voucher line touching this party's ledger
//          (invoices, receipts, payments, journals — all of them)

const express = require("express");
const mongoose = require("mongoose");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const router = express.Router();
const auth = accountantAuth;

// Group name a party kind lives under.
const GROUP_FOR = {
  vendor: /sundry creditor/i,
  customer: /sundry debtor/i,
};

// Resolve every group id whose name (or ancestry) matches the kind's
// Sundry group, so sub-grouped ledgers are included too.
async function groupIdsForKind(cId, kind) {
  const rx = GROUP_FOR[kind];
  const all = await Acc_Group.find({ companyId: cId })
    .select("_id name parent parentName")
    .lean();
  const direct = all.filter((g) => rx.test(g.name || ""));
  const ids = new Set(direct.map((g) => String(g._id)));
  // include descendants (one or more levels)
  let added = true;
  let guard = 0;
  while (added && guard < 20) {
    added = false;
    guard++;
    for (const g of all) {
      if (ids.has(String(g._id))) continue;
      const parentRef =
        (g.parent && String(g.parent)) ||
        (g.parentName &&
          all.find((x) => x.name === g.parentName)?._id &&
          String(all.find((x) => x.name === g.parentName)._id));
      if (parentRef && ids.has(parentRef)) {
        ids.add(String(g._id));
        added = true;
      }
    }
  }
  return [...ids].map((s) => new mongoose.Types.ObjectId(s));
}

// Net signed movement (Dr +, Cr −) per ledger from POSTED vouchers.
async function balanceByLedger(cId, ledgerIds) {
  if (!ledgerIds.length) return new Map();
  const agg = await Acc_Voucher.aggregate([
    { $match: { companyId: cId, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        dr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Dr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        cr: {
          $sum: {
            $cond: [
              { $eq: ["$ledgerEntries.type", "Cr"] },
              "$ledgerEntries.amount",
              0,
            ],
          },
        },
        txns: { $sum: 1 },
      },
    },
  ]);
  const m = new Map();
  for (const r of agg)
    m.set(String(r._id), {
      dr: r.dr || 0,
      cr: r.cr || 0,
      net: (r.dr || 0) - (r.cr || 0),
      txns: r.txns || 0,
    });
  return m;
}

/* ------------------------------------------------------------------ */
/* GET /parties                                                        */
/* ------------------------------------------------------------------ */
router.get("/", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const kind = req.query.kind === "customer" ? "customer" : "vendor";
    const search = (req.query.search || "").trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    const cId = new mongoose.Types.ObjectId(companyId);

    const gIds = await groupIdsForKind(cId, kind);
    if (!gIds.length)
      return res.json({
        kind,
        parties: [],
        total: 0,
        page,
        pages: 0,
        note: `No "${kind === "vendor" ? "Sundry Creditors" : "Sundry Debtors"}" group found — import Tally masters first.`,
      });

    const filter = { companyId: cId, groupId: { $in: gIds } };
    if (search)
      filter.name = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );

    const total = await Acc_Ledger.countDocuments(filter);
    const ledgers = await Acc_Ledger.find(filter)
      .select("name gstin aliases groupName openingBalance openingBalanceType")
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const balMap = await balanceByLedger(
      cId,
      ledgers.map((l) => l._id),
    );

    const parties = ledgers.map((l) => {
      const b = balMap.get(String(l._id)) || {
        dr: 0,
        cr: 0,
        net: 0,
        txns: 0,
      };
      const openSigned =
        (l.openingBalanceType === "Cr" ? -1 : 1) *
        Math.abs(l.openingBalance || 0);
      const closingSigned = openSigned + b.net;
      return {
        ledgerId: l._id,
        name: l.name,
        gstin: l.gstin || null,
        aliases: l.aliases || [],
        groupName: l.groupName || null,
        openingBalance: Math.abs(openSigned),
        openingType: openSigned < 0 ? "Cr" : "Dr",
        debitTotal: b.dr,
        creditTotal: b.cr,
        transactionCount: b.txns,
        balance: Math.abs(closingSigned),
        balanceType: closingSigned < 0 ? "Cr" : "Dr",
      };
    });

    res.json({
      kind,
      parties,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    console.error("[parties/list]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /parties/:ledgerId                                              */
/* ------------------------------------------------------------------ */
router.get("/:ledgerId", auth, async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const cId = new mongoose.Types.ObjectId(companyId);
    const led = await Acc_Ledger.findOne({
      _id: req.params.ledgerId,
      companyId: cId,
    }).lean();
    if (!led) return res.status(404).json({ error: "Party not found" });

    const balMap = await balanceByLedger(cId, [led._id]);
    const b = balMap.get(String(led._id)) || {
      dr: 0,
      cr: 0,
      net: 0,
      txns: 0,
    };
    const openSigned =
      (led.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs(led.openingBalance || 0);
    const closingSigned = openSigned + b.net;
    const kind = /creditor/i.test(led.groupName || "") ? "vendor" : "customer";

    res.json({
      ledgerId: led._id,
      name: led.name,
      gstin: led.gstin || null,
      aliases: led.aliases || [],
      groupName: led.groupName || null,
      kind,
      openingBalance: Math.abs(openSigned),
      openingType: openSigned < 0 ? "Cr" : "Dr",
      debitTotal: b.dr,
      creditTotal: b.cr,
      transactionCount: b.txns,
      balance: Math.abs(closingSigned),
      balanceType: closingSigned < 0 ? "Cr" : "Dr",
    });
  } catch (e) {
    console.error("[parties/detail]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /parties/:ledgerId/transactions                                 */
/* Every posted voucher line touching this party's ledger.             */
/* ------------------------------------------------------------------ */
router.get("/:ledgerId/transactions", auth, async (req, res) => {
  try {
    const { companyId, from, to } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const cId = new mongoose.Types.ObjectId(companyId);
    const lId = new mongoose.Types.ObjectId(req.params.ledgerId);

    const match = {
      companyId: cId,
      status: "posted",
      "ledgerEntries.ledgerId": lId,
    };
    if (from || to) {
      match.voucherDate = {};
      if (from) match.voucherDate.$gte = new Date(from);
      if (to) {
        const e = new Date(to);
        e.setHours(23, 59, 59, 999);
        match.voucherDate.$lte = e;
      }
    }

    const vouchers = await Acc_Voucher.find(match)
      .select(
        "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries grandTotal status",
      )
      .sort({ voucherDate: 1, createdAt: 1 })
      .lean();

    // Build a running statement for THIS ledger.
    const led = await Acc_Ledger.findById(lId)
      .select("name openingBalance openingBalanceType")
      .lean();
    let running =
      (led && led.openingBalanceType === "Cr" ? -1 : 1) *
      Math.abs((led && led.openingBalance) || 0);

    const rows = [];
    for (const v of vouchers) {
      // Sum this ledger's lines within the voucher (a voucher can hit the
      // same ledger more than once).
      let dr = 0;
      let cr = 0;
      for (const e of v.ledgerEntries || []) {
        if (String(e.ledgerId) !== String(lId)) continue;
        if (e.type === "Dr") dr += e.amount || 0;
        else cr += e.amount || 0;
      }
      running += dr - cr;
      rows.push({
        voucherId: v._id,
        date: v.voucherDate,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherTypeName || v.voucherType,
        voucherNumber: v.voucherNumber || null,
        narration: v.narration || null,
        counterParty: v.partyLedgerName || null,
        debit: dr,
        credit: cr,
        runningBalance: Math.abs(running),
        runningType: running < 0 ? "Cr" : "Dr",
        grandTotal: v.grandTotal || null,
      });
    }

    res.json({
      ledgerId: lId,
      name: led ? led.name : null,
      openingBalance: Math.abs(
        (led && led.openingBalanceType === "Cr" ? -1 : 1) *
          Math.abs((led && led.openingBalance) || 0),
      ),
      count: rows.length,
      transactions: rows,
      closingBalance: Math.abs(running),
      closingType: running < 0 ? "Cr" : "Dr",
    });
  } catch (e) {
    console.error("[parties/transactions]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
