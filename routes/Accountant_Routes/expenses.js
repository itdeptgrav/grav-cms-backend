// routes/Accountant_Routes/expenses.js
//
// EXPENSES — operational expense tracking that ACTUALLY POSTS to books.
//
// Architecture decision: an "expense" in our system is a TallyVoucher
// of type "payment" or "journal" with `sourceSystem: "expense_module"`.
// We don't have a separate Expense collection — that would create data
// drift between this page and P&L / Trial Balance / Day Book.
//
// Two posting modes (selected by the user on the form):
//   1. "pay_now"  → voucherType "payment"
//        Dr Expense ledger      (operating cost)
//        Dr GST Input           (if GST applicable, claimable on GSTR-3B)
//        Cr Bank/Cash ledger    (money leaves)
//
//   2. "pay_later" → voucherType "journal"
//        Dr Expense ledger
//        Dr GST Input           (if applicable)
//        Cr Vendor (Sundry Creditor)   (creates liability — settle later)
//
// Both modes update ledger balances via the unified applyLedgerBalances
// flow, so the expense immediately appears in:
//   • Day Book
//   • P&L (Indirect Expenses)
//   • Trial Balance
//   • Bank ledger statement (pay_now) OR Vendor ledger (pay_later)
//   • GSTR-3B / GSTR Summary (input GST)
//
// LEGACY NOTE: The previous version of this file imported a non-existent
// "AccountantModels.Expense" and crashed at module-load. Page was showing
// zeros because of the silent route mount failure. This is a clean rewrite.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  TallyVoucher,
} = require("../../models/Accountant_model/TallyVoucherModels");
const {
  TallyLedger,
  TallyGroup,
} = require("../../models/Accountant_model/TallyMasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

router.use(accountantAuth);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function computeFY(dateInput) {
  const d = new Date(dateInput);
  const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${fy}-${(fy + 1).toString().slice(2)}`;
}

/**
 * Apply ledger balance updates from a voucher's ledger entries.
 * +1 to post, -1 to reverse. Mirrors the helper in tallyVouchers.js.
 */
async function applyLedgerBalances(voucher, direction = 1) {
  const ops = [];
  for (const entry of voucher.ledgerEntries) {
    const lid = entry.ledgerId || entry.ledger;
    if (!lid) continue;
    const delta = (entry.signedAmount || 0) * direction;
    ops.push({
      updateOne: {
        filter: { _id: lid },
        update: { $inc: { currentBalance: delta } },
      },
    });
  }
  if (ops.length) await TallyLedger.bulkWrite(ops);

  // Refresh balanceType per touched ledger
  for (const entry of voucher.ledgerEntries) {
    const lid = entry.ledgerId || entry.ledger;
    if (!lid) continue;
    const led = await TallyLedger.findById(lid);
    if (led) {
      led.balanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
      await led.save();
    }
  }
}

/* ------------------------------------------------------------------ */
/* GET /expense-ledgers — list of expense ledgers for the form picker  */
/* ------------------------------------------------------------------ */
/* Returns every active ledger whose nature is "expense", grouped by
 * their parent group. Used by the expense form's category picker.
 */
router.get("/expense-ledgers", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const ledgers = await TallyLedger.find({
      companyId,
      isActive: true,
      nature: "expense",
    })
      .sort({ groupName: 1, name: 1 })
      .select("name groupName groupId currentBalance balanceType")
      .lean();
    res.json({ ledgers });
  } catch (e) {
    console.error("[expenses/expense-ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GST Input ledgers — used when GST is claimable on an expense        */
/* ------------------------------------------------------------------ */
router.get("/gst-input-ledgers", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    const ledgers = await TallyLedger.find({
      companyId,
      isActive: true,
      name: { $in: [/^cgst\s*input$/i, /^sgst\s*input$/i, /^igst\s*input$/i] },
    }).lean();
    const map = {};
    for (const l of ledgers) {
      if (/cgst/i.test(l.name)) map.cgst = l;
      else if (/sgst/i.test(l.name)) map.sgst = l;
      else if (/igst/i.test(l.name)) map.igst = l;
    }
    res.json({ ledgers: map });
  } catch (e) {
    console.error("[expenses/gst-input-ledgers]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET / — list expenses                                               */
/* ------------------------------------------------------------------ */
/* Returns TallyVouchers with sourceSystem "expense_module" plus a
 * computed `expenseLedger` and `paymentMode` per row for table display.
 *
 * Query: companyId, status, search, dateFrom, dateTo, page, limit,
 *        mode ("pay_now" | "pay_later" | "")
 */
router.get("/", async (req, res) => {
  try {
    const {
      companyId,
      status,
      paymentStatus,
      search,
      dateFrom,
      dateTo,
      page = 1,
      limit = 50,
      mode,
    } = req.query;

    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const filter = {
      companyId,
      sourceSystem: "expense_module",
    };

    // The legacy frontend uses paymentStatus = "paid" | "pending" | "partial"
    // We translate that to voucher status + voucherType:
    //   paid    → voucherType "payment" (money already gone out)
    //   pending → voucherType "journal" (still owed to a vendor)
    if (paymentStatus === "paid") filter.voucherType = "payment";
    else if (paymentStatus === "pending") filter.voucherType = "journal";
    if (mode === "pay_now") filter.voucherType = "payment";
    if (mode === "pay_later") filter.voucherType = "journal";

    // Voucher status:
    //   draft → "draft"
    //   approved/posted → "posted"
    //   rejected → "cancelled"
    if (status === "approved") filter.status = "posted";
    else if (status === "rejected") filter.status = "cancelled";
    else if (status === "pending") filter.status = "draft";
    else if (status === "draft") filter.status = "draft";

    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) filter.voucherDate.$lte = new Date(dateTo);
    }

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { voucherNumber: rx },
        { narration: rx },
        { partyLedgerName: rx },
        { sourceReference: rx },
        { referenceNumber: rx },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [vouchers, total] = await Promise.all([
      TallyVoucher.find(filter)
        .sort({ voucherDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      TallyVoucher.countDocuments(filter),
    ]);

    // Decorate each voucher with a per-row "expenseLedger" (the first Dr
    // entry whose ledger nature was expense) for the table display.
    const decorated = vouchers.map((v) => {
      const drEntries = (v.ledgerEntries || []).filter((e) => e.type === "Dr");
      // The first Dr entry — usually the expense ledger
      const expenseLeg = drEntries[0] || null;
      const mode = v.voucherType === "payment" ? "pay_now" : "pay_later";
      const paymentStatus = v.voucherType === "payment" ? "paid" : "pending";
      const uiStatus =
        v.status === "posted"
          ? "approved"
          : v.status === "cancelled"
            ? "rejected"
            : v.status === "draft"
              ? "pending"
              : v.status;
      return {
        ...v,
        // Backwards-compat aliases for the existing UI
        expenseId: v.voucherNumber,
        description: v.narration,
        category: expenseLeg?.ledgerName || "—",
        vendorName: v.partyLedgerName || "",
        totalAmount: v.grandTotal,
        status: uiStatus,
        paymentStatus,
        mode,
        createdAt: v.createdAt || v.voucherDate,
      };
    });

    // Summary KPIs
    const allForSummary = await TallyVoucher.find(filter)
      .select("grandTotal voucherType status")
      .lean();
    const summary = {
      totalAmount: allForSummary.reduce((s, e) => s + (e.grandTotal || 0), 0),
      totalPaid: allForSummary
        .filter((e) => e.voucherType === "payment" && e.status === "posted")
        .reduce((s, e) => s + (e.grandTotal || 0), 0),
      totalPending: allForSummary
        .filter((e) => e.voucherType === "journal" && e.status === "posted")
        .reduce((s, e) => s + (e.grandTotal || 0), 0),
      count: total,
    };

    res.json({
      success: true,
      expenses: decorated,
      summary,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e) {
    console.error("[expenses/list]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST / — create an expense (posts as Payment or Journal voucher)    */
/* ------------------------------------------------------------------ */
/* Body shape (form-friendly):
 *   companyId        — required
 *   voucherDate      — ISO date (defaults today)
 *   description      — narration
 *   expenseLedgerId  — required, an expense-nature ledger
 *   amount           — required, > 0 (taxable amount, before GST)
 *   mode             — "pay_now" | "pay_later"
 *   bankLedgerId     — required when mode = pay_now
 *   vendorLedgerId   — required when mode = pay_later
 *   gstApplicable    — boolean
 *   gstRate          — number (5/12/18/28)
 *   isInterstate     — boolean (IGST if true, otherwise CGST+SGST)
 *   referenceNumber  — optional (bill #, voucher ref)
 *   autoPost         — if true, post immediately; else save as draft
 */
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const {
      companyId,
      voucherDate,
      description,
      expenseLedgerId,
      amount,
      mode = "pay_now",
      bankLedgerId,
      vendorLedgerId,
      gstApplicable,
      gstRate = 18,
      isInterstate = false,
      referenceNumber,
      autoPost = true,
    } = body;

    // ── Validation ──────────────────────────────────────────────────
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!expenseLedgerId)
      return res.status(400).json({ error: "expenseLedgerId required" });
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ error: "amount must be > 0" });
    if (mode === "pay_now" && !bankLedgerId)
      return res
        .status(400)
        .json({ error: "bankLedgerId required for pay_now" });
    if (mode === "pay_later" && !vendorLedgerId)
      return res
        .status(400)
        .json({ error: "vendorLedgerId required for pay_later" });

    // ── Resolve referenced ledgers ──────────────────────────────────
    const expenseLg = await TallyLedger.findById(expenseLedgerId);
    if (!expenseLg)
      return res.status(400).json({ error: "Expense ledger not found" });
    if (expenseLg.nature !== "expense") {
      return res.status(400).json({
        error: `Selected ledger '${expenseLg.name}' is not an expense ledger (nature is ${expenseLg.nature})`,
      });
    }

    let counterLg; // bank or vendor
    if (mode === "pay_now") {
      counterLg = await TallyLedger.findById(bankLedgerId);
      if (!counterLg)
        return res.status(400).json({ error: "Bank ledger not found" });
    } else {
      counterLg = await TallyLedger.findById(vendorLedgerId);
      if (!counterLg)
        return res.status(400).json({ error: "Vendor ledger not found" });
    }

    // ── GST math ────────────────────────────────────────────────────
    const G = (n) => Math.round(Number(n) * 100) / 100;
    const taxable = G(amount);
    let cgst = 0,
      sgst = 0,
      igst = 0,
      totalTax = 0;
    let gstLedgers = {};
    if (gstApplicable) {
      const tax = G(taxable * (gstRate / 100));
      if (isInterstate) {
        igst = tax;
        totalTax = tax;
      } else {
        cgst = G(tax / 2);
        sgst = G(tax / 2);
        totalTax = cgst + sgst;
      }
      // Resolve GST Input ledgers (input — claimable, not payable)
      const gstRows = await TallyLedger.find({
        companyId,
        isActive: true,
        name: {
          $in: [/^cgst\s*input$/i, /^sgst\s*input$/i, /^igst\s*input$/i],
        },
      }).lean();
      for (const l of gstRows) {
        if (/cgst/i.test(l.name)) gstLedgers.cgst = l;
        else if (/sgst/i.test(l.name)) gstLedgers.sgst = l;
        else if (/igst/i.test(l.name)) gstLedgers.igst = l;
      }
      if (isInterstate && !gstLedgers.igst) {
        return res
          .status(400)
          .json({ error: "IGST Input ledger missing in Chart of Accounts" });
      }
      if (!isInterstate && (!gstLedgers.cgst || !gstLedgers.sgst)) {
        return res.status(400).json({
          error: "CGST/SGST Input ledgers missing in Chart of Accounts",
        });
      }
    }

    const grandTotal = G(taxable + totalTax);

    // ── Build ledger entries ────────────────────────────────────────
    const ledgerEntries = [];

    // Dr: Expense ledger (taxable value)
    ledgerEntries.push({
      ledgerId: expenseLg._id,
      ledgerName: expenseLg.name,
      groupName: expenseLg.groupName,
      type: "Dr",
      amount: taxable,
      signedAmount: taxable,
      narration: description || expenseLg.name,
    });

    // Dr: GST Input legs
    if (gstApplicable) {
      if (isInterstate) {
        ledgerEntries.push({
          ledgerId: gstLedgers.igst._id,
          ledgerName: gstLedgers.igst.name,
          type: "Dr",
          amount: igst,
          signedAmount: igst,
          narration: "IGST input",
        });
      } else {
        ledgerEntries.push({
          ledgerId: gstLedgers.cgst._id,
          ledgerName: gstLedgers.cgst.name,
          type: "Dr",
          amount: cgst,
          signedAmount: cgst,
          narration: "CGST input",
        });
        ledgerEntries.push({
          ledgerId: gstLedgers.sgst._id,
          ledgerName: gstLedgers.sgst.name,
          type: "Dr",
          amount: sgst,
          signedAmount: sgst,
          narration: "SGST input",
        });
      }
    }

    // Cr: Bank/Cash (pay_now) or Vendor (pay_later)
    ledgerEntries.push({
      ledgerId: counterLg._id,
      ledgerName: counterLg.name,
      groupName: counterLg.groupName,
      type: "Cr",
      amount: grandTotal,
      signedAmount: -grandTotal,
      isPartyLedger: mode === "pay_later",
      narration:
        mode === "pay_now"
          ? `Paid via ${counterLg.name}`
          : `Payable to ${counterLg.name}`,
    });

    // ── Build voucher document ──────────────────────────────────────
    const voucherType = mode === "pay_now" ? "payment" : "journal";
    const voucherNumber = await TallyVoucher.nextVoucherNumber(
      companyId,
      voucherType,
    );
    const fy = computeFY(voucherDate || new Date());

    const totalDr = ledgerEntries
      .filter((e) => e.type === "Dr")
      .reduce((s, e) => s + e.amount, 0);
    const totalCr = ledgerEntries
      .filter((e) => e.type === "Cr")
      .reduce((s, e) => s + e.amount, 0);

    const voucher = await TallyVoucher.create({
      companyId,
      voucherType,
      voucherNumber,
      voucherDate: voucherDate || new Date(),
      financialYear: fy,
      narration: description || "",
      referenceNumber: referenceNumber || "",
      partyLedgerId: mode === "pay_later" ? counterLg._id : undefined,
      partyLedgerName: mode === "pay_later" ? counterLg.name : undefined,
      ledgerEntries,
      subtotal: taxable,
      gstBreakup: { cgst, sgst, igst },
      totalTax,
      grandTotal,
      totalDebit: totalDr,
      totalCredit: totalCr,
      status: autoPost ? "posted" : "draft",
      sourceSystem: "expense_module",
      sourceReference: description || "",
      enteredBy: req.user?.id,
      postedBy: autoPost ? req.user?.id : undefined,
      postedAt: autoPost ? new Date() : undefined,
    });

    // Apply balance updates only when posted
    if (autoPost) await applyLedgerBalances(voucher, +1);

    res.status(201).json({
      success: true,
      expense: {
        ...voucher.toObject(),
        // Backwards-compat aliases
        expenseId: voucher.voucherNumber,
        description: voucher.narration,
        category: expenseLg.name,
        vendorName: mode === "pay_later" ? counterLg.name : "",
        totalAmount: voucher.grandTotal,
        paymentStatus: mode === "pay_now" ? "paid" : "pending",
        mode,
      },
    });
  } catch (e) {
    console.error("[expenses/create]", e);
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:id/approve — approve a draft expense (posts to books)        */
/* ------------------------------------------------------------------ */
router.post("/:id/approve", async (req, res) => {
  try {
    const v = await TallyVoucher.findById(req.params.id);
    if (!v) return res.status(404).json({ error: "Expense not found" });
    if (v.sourceSystem !== "expense_module") {
      return res.status(400).json({ error: "Not an expense voucher" });
    }
    if (v.status === "posted") {
      return res.status(400).json({ error: "Already approved" });
    }
    v.status = "posted";
    v.postedBy = req.user?.id;
    v.postedAt = new Date();
    await v.save();
    await applyLedgerBalances(v, +1);
    res.json({ success: true, expense: v });
  } catch (e) {
    console.error("[expenses/approve]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /:id/reject — reject a draft / unpost an approved expense      */
/* ------------------------------------------------------------------ */
router.post("/:id/reject", async (req, res) => {
  try {
    const { reason = "" } = req.body || {};
    const v = await TallyVoucher.findById(req.params.id);
    if (!v) return res.status(404).json({ error: "Expense not found" });
    if (v.sourceSystem !== "expense_module") {
      return res.status(400).json({ error: "Not an expense voucher" });
    }
    // If it was already posted, reverse the ledger impact first
    if (v.status === "posted") {
      await applyLedgerBalances(v, -1);
    }
    v.status = "cancelled";
    v.cancelledBy = req.user?.id;
    v.cancelledAt = new Date();
    v.cancellationReason = reason;
    await v.save();
    res.json({ success: true, expense: v });
  } catch (e) {
    console.error("[expenses/reject]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /:id — single expense detail                                    */
/* ------------------------------------------------------------------ */
router.get("/:id", async (req, res) => {
  try {
    const v = await TallyVoucher.findById(req.params.id).lean();
    if (!v) return res.status(404).json({ error: "Expense not found" });
    res.json({ expense: v });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
