/**
 * Tally Voucher Routes
 * Handles all voucher types (sales, purchase, receipt, payment, contra, journal, credit_note, debit_note, etc.)
 * - Auto-numbering per FY per voucher type
 * - Status transitions: draft → posted → cancelled/void
 * - Updates ledger balances atomically on post
 * - Filtering by type, party, date range, status
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const {
  TallyVoucher,
} = require("../../models/Accountant_model/TallyVoucherModels");
const {
  TallyLedger,
} = require("../../models/Accountant_model/TallyMasterModels");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const auth = accountantAuth;

const VOUCHER_TYPES = [
  "sales",
  "purchase",
  "receipt",
  "payment",
  "contra",
  "journal",
  "credit_note",
  "debit_note",
  "stock_journal",
  "delivery_note",
  "receipt_note",
  "rejection_in",
  "rejection_out",
  "memo",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function computeFY(dateInput) {
  const d = new Date(dateInput);
  const m = d.getMonth();
  const y = d.getFullYear();
  // India FY April-March
  return m >= 3
    ? `${y}-${String((y + 1) % 100).padStart(2, "0")}`
    : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

/**
 * Apply ledger balance updates from a voucher's ledger entries.
 * direction = +1 for posting, -1 for cancelling/voiding
 */
async function applyLedgerBalances(voucher, direction = 1, session = null) {
  const ops = [];
  for (const entry of voucher.ledgerEntries) {
    const delta = (entry.signedAmount || 0) * direction;
    ops.push({
      updateOne: {
        filter: { _id: entry.ledgerId },
        update: { $inc: { currentBalance: delta } },
      },
    });
  }
  if (ops.length) {
    await TallyLedger.bulkWrite(ops, { session });
  }
  // Refresh currentBalanceType per ledger touched
  for (const entry of voucher.ledgerEntries) {
    const led = await TallyLedger.findById(entry.ledgerId).session(session);
    if (led) {
      led.currentBalanceType = led.currentBalance >= 0 ? "Dr" : "Cr";
      await led.save({ session });
    }
  }
}

/* ------------------------------------------------------------------ */
/* List & filter                                                       */
/* ------------------------------------------------------------------ */

router.get("/", auth, async (req, res) => {
  try {
    const {
      companyId,
      voucherType,
      party,
      status,
      dateFrom,
      dateTo,
      q,
      page = 1,
      limit = 50,
      sort = "-voucherDate",
    } = req.query;

    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const filter = { companyId };
    if (voucherType) filter.voucherType = voucherType;
    if (status) filter.status = status;
    if (party) filter.partyLedgerId = party;
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) filter.voucherDate.$lte = new Date(dateTo);
    }
    if (q) {
      filter.$or = [
        { voucherNumber: new RegExp(q, "i") },
        { narration: new RegExp(q, "i") },
        { partyLedgerName: new RegExp(q, "i") },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      TallyVoucher.find(filter)
        .populate("partyLedgerId", "name groupName")
        .sort(sort)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      TallyVoucher.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Get one                                                             */
/* ------------------------------------------------------------------ */

router.get("/:id", auth, async (req, res) => {
  try {
    const voucher = await TallyVoucher.findById(req.params.id)
      .populate("partyLedgerId", "name groupName gstin")
      .populate("ledgerEntries.ledgerId", "name groupName")
      .populate("inventoryEntries.stockItemId", "name unit hsnCode")
      .lean();
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    res.json(voucher);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Get next voucher number (used by frontend on form open)             */
/* ------------------------------------------------------------------ */

router.get("/next-number/:companyId/:voucherType", auth, async (req, res) => {
  try {
    const { companyId, voucherType } = req.params;
    const { prefix } = req.query;
    const number = await TallyVoucher.nextVoucherNumber(
      companyId,
      voucherType,
      prefix,
    );
    res.json({ voucherNumber: number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

router.post("/", auth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.companyId)
      return res.status(400).json({ error: "companyId required" });
    if (!body.voucherType || !VOUCHER_TYPES.includes(body.voucherType))
      return res.status(400).json({ error: "Valid voucherType required" });
    if (!body.voucherDate)
      return res.status(400).json({ error: "voucherDate required" });
    if (!Array.isArray(body.ledgerEntries) || body.ledgerEntries.length === 0)
      return res
        .status(400)
        .json({ error: "At least one ledger entry required" });

    // Auto-number if not provided
    if (!body.voucherNumber) {
      body.voucherNumber = await TallyVoucher.nextVoucherNumber(
        body.companyId,
        body.voucherType,
        body.prefix,
      );
    }

    body.financialYear = computeFY(body.voucherDate);
    body.createdBy = req.user?.id;

    // Resolve partyLedgerName if missing
    if (body.partyLedgerId && !body.partyLedgerName) {
      const led = await TallyLedger.findById(body.partyLedgerId).select("name");
      if (led) body.partyLedgerName = led.name;
    }

    // Resolve ledger names
    for (const entry of body.ledgerEntries) {
      if (entry.ledgerId && !entry.ledgerName) {
        const led = await TallyLedger.findById(entry.ledgerId).select("name");
        if (led) entry.ledgerName = led.name;
      }
    }

    const voucher = new TallyVoucher(body);
    await voucher.save();

    // Auto-post if requested and balanced
    if (body.autoPost && voucher.isBalanced) {
      voucher.status = "posted";
      await voucher.save();
      await applyLedgerBalances(voucher, +1);
    }

    res.status(201).json(voucher);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Update (only if draft)                                              */
/* ------------------------------------------------------------------ */

router.put("/:id", auth, async (req, res) => {
  try {
    const existing = await TallyVoucher.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Voucher not found" });
    if (existing.status !== "draft")
      return res.status(400).json({
        error: `Cannot edit voucher in '${existing.status}' status. Cancel and create new.`,
      });

    const body = req.body || {};
    body.updatedBy = req.user?.id;
    if (body.voucherDate) body.financialYear = computeFY(body.voucherDate);

    Object.assign(existing, body);
    await existing.save();
    res.json(existing);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

router.post("/:id/post", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const voucher = await TallyVoucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== "draft")
      throw new Error(`Voucher already ${voucher.status}`);
    if (!voucher.isBalanced)
      throw new Error("Voucher Dr/Cr totals do not balance — cannot post");

    voucher.status = "posted";
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });
    await applyLedgerBalances(voucher, +1, session);

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    await session.abortTransaction();
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

router.post("/:id/cancel", auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const voucher = await TallyVoucher.findById(req.params.id).session(session);
    if (!voucher) throw new Error("Voucher not found");
    if (!["posted", "draft"].includes(voucher.status))
      throw new Error(`Cannot cancel voucher in '${voucher.status}' status`);

    if (voucher.status === "posted") {
      await applyLedgerBalances(voucher, -1, session);
    }
    voucher.status = "cancelled";
    voucher.updatedBy = req.user?.id;
    await voucher.save({ session });

    await session.commitTransaction();
    res.json(voucher);
  } catch (e) {
    await session.abortTransaction();
    res.status(400).json({ error: e.message });
  } finally {
    session.endSession();
  }
});

router.post("/:id/void", auth, async (req, res) => {
  try {
    const voucher = await TallyVoucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status === "posted") {
      await applyLedgerBalances(voucher, -1);
    }
    voucher.status = "void";
    voucher.updatedBy = req.user?.id;
    await voucher.save();
    res.json(voucher);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Delete (only drafts can be hard-deleted)                            */
/* ------------------------------------------------------------------ */

router.delete("/:id", auth, async (req, res) => {
  try {
    const voucher = await TallyVoucher.findById(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status !== "draft")
      return res.status(400).json({
        error:
          "Only draft vouchers can be deleted. Use cancel/void for posted.",
      });
    await voucher.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Bulk summary by type for a date range — for dashboards              */
/* ------------------------------------------------------------------ */

router.get("/summary/by-type", auth, async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    if (!companyId)
      return res.status(400).json({ error: "companyId required" });

    const match = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: "posted",
    };
    if (dateFrom || dateTo) {
      match.voucherDate = {};
      if (dateFrom) match.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) match.voucherDate.$lte = new Date(dateTo);
    }

    const summary = await TallyVoucher.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$voucherType",
          count: { $sum: 1 },
          totalDebit: { $sum: "$totalDebit" },
          totalCredit: { $sum: "$totalCredit" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
