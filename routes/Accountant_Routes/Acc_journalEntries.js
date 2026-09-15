// routes/Accountant_Routes/Acc_journalEntries.js
//
// Manual journal entries, and what they do to the books.
//
// This router used to be a filing cabinet: it created rows, and "posting" one
// set a status string. Nothing reached the ledger, because every report in the
// accounting module is built from Acc_Voucher and a journal entry never became
// one. Posting now writes a real journal voucher — see
// services/journalEntryPosting.service.js for the whole story.
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_JournalEntry,
  ActivityLog,
} = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
/* Required for its side effect: `createdBy` and `postedBy` are populated
   below, and mongoose resolves a ref by model NAME at query time. A ref does
   not register anything, so without this the populate throws "Schema hasn't
   been registered for model Acc_Department" and the whole request 500s —
   and only when createdBy is actually set, which is why the list survived and
   the detail route did not. Registering it here makes this router stand on
   its own rather than on whichever other route happened to load first. */
require("../../models/Accountant_model/Acc_Department");
const {
  lineLedgerId,
  postJournalEntry,
  voidJournalEntry,
} = require("../../services/journalEntryPosting.service");

router.use(AccountantAuthMiddleware.accountantAuth);

const asObjectId = (v) => {
  const s = String(v || "");
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

/* What the UI needs to tell the truth about an entry. An entry marked posted
   with no voucher behind it was posted under the old behaviour and has not
   reached the ledger — it must not be presented as though it had. */
const withPostingState = (e) => ({
  ...e,
  postedToLedger: Boolean(e.voucherId),
  needsLedgerPosting: e.status === "posted" && !e.voucherId,
});

// GET all journal entries
router.get("/", async (req, res) => {
  try {
    const {
      status,
      type,
      sourceType,
      startDate,
      endDate,
      page = 1,
      limit = 20,
      search,
      companyId,
    } = req.query;
    let filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (sourceType) filter.sourceType = sourceType;

    /* Scoped to the company when one is given. Entries written before the
       schema had a companyId belong to no company; they are included rather
       than hidden, or the fix would make a company's existing entries vanish
       from its own list. */
    const cid = asObjectId(companyId);
    if (cid) {
      filter.$and = [
        { $or: [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }] },
      ];
    }

    if (search) {
      const or = [
        { narration: { $regex: search, $options: "i" } },
        { entryNumber: { $regex: search, $options: "i" } },
      ];
      if (filter.$and) filter.$and.push({ $or: or });
      else filter.$or = or;
    }
    if (startDate || endDate) {
      filter.entryDate = {};
      if (startDate) filter.entryDate.$gte = new Date(startDate);
      if (endDate) filter.entryDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [entries, total] = await Promise.all([
      Acc_JournalEntry.find(filter)
        .sort({ entryDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("createdBy", "name")
        .lean(),
      Acc_JournalEntry.countDocuments(filter),
    ]);

    res.json({
      success: true,
      entries: entries.map(withPostingState),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching journal entries:", error);
    res
      .status(500)
      .json({ success: false, message: "Error fetching journal entries" });
  }
});

/* GET single entry — what the View panel shows.
   It returns the voucher the entry became alongside it, because the question
   somebody opens this panel to answer is "did this actually hit the books,
   and as what?" — and for every entry written before posting worked, the
   honest answer is no. */
router.get("/:id", async (req, res) => {
  try {
    const entry = await Acc_JournalEntry.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("postedBy", "name email")
      .lean();
    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });

    let voucher = null;
    if (entry.voucherId) {
      voucher = await Acc_Voucher.findById(entry.voucherId)
        .select(
          "voucherNumber voucherType voucherDate status totalDebit totalCredit isBalanced ledgerEntries narration",
        )
        .lean();
    }

    res.json({
      success: true,
      entry: withPostingState(entry),
      voucher,
      /* Spelled out rather than re-derived in the browser, so the panel and
         the server cannot disagree about what may be done to this entry. */
      can: {
        edit: entry.status === "draft",
        post: entry.status === "draft" || (entry.status === "posted" && !entry.voucherId),
        cancel: entry.status === "draft",
        void: entry.status === "posted",
        delete: entry.status === "draft",
      },
    });
  } catch (error) {
    console.error("Error fetching journal entry:", error);
    res.status(500).json({ success: false, message: "Error fetching entry" });
  }
});

// CREATE journal entry
router.post("/", async (req, res) => {
  try {
    const data = { ...req.body };
    data.createdBy = req.user.id;

    /* An entry with no company cannot be posted to anything, and until now
       one was accepted and quietly stored anyway. Refused at the door: an
       entry that can never reach the ledger is not worth keeping. */
    if (!asObjectId(data.companyId)) {
      return res.status(400).json({
        success: false,
        message: "companyId is required — an entry has to belong to a company's books.",
      });
    }

    /* The page sends the chosen ledger's id in `accountCode`. Copy it into the
       real field so the line points at a ledger rather than at a name. */
    data.lines = (data.lines || []).map((l) => {
      const id = lineLedgerId(l);
      return { ...l, ledgerId: id || undefined };
    });

    // Calculate totals
    data.totalDebit = data.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    data.totalCredit = data.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);

    // Validate debit = credit
    if (Math.abs(data.totalDebit - data.totalCredit) > 0.01) {
      return res
        .status(400)
        .json({ success: false, message: "Total debit must equal total credit" });
    }

    /* Created as a draft unless posting was asked for. Whether it reaches the
       books is decided by the posting service, so both paths behave the same. */
    const postNow = data.status === "posted" || req.body.postImmediately === true;
    data.status = "draft";
    delete data.voucherId;
    delete data.voucherNumber;

    const entry = await Acc_JournalEntry.create(data);

    if (postNow) {
      const result = await postJournalEntry(entry, req.user);
      if (!result.ok) {
        /* The entry is kept as a draft with the reason, rather than thrown
           away — the numbers in it are somebody's work. */
        return res.status(400).json({
          success: false,
          message: result.message,
          reason: result.code,
          entry: withPostingState(entry.toObject()),
        });
      }
      const fresh = await Acc_JournalEntry.findById(entry._id).lean();
      return res.status(201).json({
        success: true,
        entry: withPostingState(fresh),
        voucher: result.voucher,
        awaitingApproval: result.awaitingApproval || false,
      });
    }

    res.status(201).json({ success: true, entry: withPostingState(entry.toObject()) });
  } catch (error) {
    console.error("Error creating journal entry:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating journal entry",
    });
  }
});

// POST journal entry — this is what actually writes it into the books
router.post("/:id/post", async (req, res) => {
  try {
    const entry = await Acc_JournalEntry.findById(req.params.id);
    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });

    /* Draft, or marked posted under the old behaviour and never actually in
       the books. The second case is the repair path: those entries say
       "posted" and have moved nothing, and clicking Post is how they get
       there. Genuinely posted entries — the ones with a live voucher — fall
       through to the idempotent check in the service and change nothing. */
    if (!["draft", "posted"].includes(entry.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${entry.status} entry cannot be posted.`,
      });
    }

    const result = await postJournalEntry(entry, req.user);
    if (!result.ok) {
      return res
        .status(400)
        .json({ success: false, message: result.message, reason: result.code });
    }

    if (result.alreadyPosted) {
      return res.json({
        success: true,
        message: `Already in the books as voucher ${result.voucher.voucherNumber}.`,
        entry: withPostingState(entry.toObject()),
        voucher: result.voucher,
      });
    }

    try {
      /* `accountantId` and `module` are both required by the schema. Written
         with the wrong field names this throws, the catch below swallows it,
         and the audit row silently never exists — so they are spelled the way
         the model spells them. */
      await ActivityLog.create({
        accountantId: req.user?.id,
        module: "journal",
        action: "journal_entry_posted",
        entityType: "journal_entry",
        entityId: entry._id,
        details: `${entry.entryNumber} posted as journal voucher ${result.voucher.voucherNumber}`,
      });
    } catch (logErr) {
      /* The log is not the entry. A logging failure must not undo a posting
         that succeeded — but it is said out loud rather than swallowed. */
      console.warn("[JOURNAL-ENTRY] activity log failed:", logErr.message);
    }

    res.json({
      success: true,
      message: result.awaitingApproval
        ? `Submitted for approval as voucher ${result.voucher.voucherNumber}.`
        : `Posted to the ledger as voucher ${result.voucher.voucherNumber}.`,
      entry: withPostingState((await Acc_JournalEntry.findById(entry._id).lean())),
      voucher: result.voucher,
      awaitingApproval: result.awaitingApproval || false,
    });
  } catch (error) {
    console.error("Error posting journal entry:", error);
    res
      .status(500)
      .json({ success: false, message: error.message || "Error posting entry" });
  }
});

/* EDIT a journal entry.
   Drafts only, and deliberately so. A posted entry is a voucher in the books;
   silently rewriting the numbers behind a voucher that other reports have
   already counted is how a ledger stops being a record. To change a posted
   entry you void it and write a new one, which leaves both facts visible. */
router.put("/:id", async (req, res) => {
  try {
    const entry = await Acc_JournalEntry.findById(req.params.id);
    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status !== "draft") {
      return res.status(400).json({
        success: false,
        reason: "NOT_A_DRAFT",
        message:
          entry.status === "posted"
            ? "This entry is already in the books. Void it and write a new one instead of editing it."
            : `A ${entry.status} entry cannot be edited.`,
      });
    }

    const body = req.body || {};
    if (Array.isArray(body.lines)) {
      const lines = body.lines.map((l) => {
        const id = lineLedgerId(l);
        return {
          accountName: l.accountName,
          ledgerId: id || undefined,
          accountCode: l.accountCode,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          description: l.description || undefined,
        };
      });
      const totalDebit = lines.reduce((t, l) => t + l.debit, 0);
      const totalCredit = lines.reduce((t, l) => t + l.credit, 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          message: "Total debit must equal total credit",
        });
      }
      entry.lines = lines;
      entry.totalDebit = totalDebit;
      entry.totalCredit = totalCredit;
    }
    if (body.entryDate) entry.entryDate = new Date(body.entryDate);
    if (body.narration !== undefined) entry.narration = body.narration;
    if (body.type) entry.type = body.type;
    /* companyId is not editable. Moving an entry between companies after the
       fact would move money between two sets of books with no record in
       either. */

    await entry.save();
    res.json({ success: true, entry: withPostingState(entry.toObject()) });
  } catch (error) {
    console.error("Error editing journal entry:", error);
    res
      .status(500)
      .json({ success: false, message: error.message || "Error editing entry" });
  }
});

/* CANCEL a draft — abandoning it before it ever reached the books.
   Distinct from void on purpose: cancelled means this never moved a balance,
   void means it did and was reversed. An auditor asking "was this ever in the
   accounts?" needs those to be different answers, so cancelling a posted entry
   is refused and pointed at void. */
router.post("/:id/cancel", async (req, res) => {
  try {
    const entry = await Acc_JournalEntry.findById(req.params.id);
    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status === "cancelled")
      return res.json({ success: true, message: "Already cancelled." });
    if (entry.status !== "draft") {
      return res.status(400).json({
        success: false,
        reason: "NOT_A_DRAFT",
        message:
          entry.status === "posted"
            ? "This entry is in the books. Use Void, which reverses the voucher as well."
            : `A ${entry.status} entry cannot be cancelled.`,
      });
    }

    entry.status = "cancelled";
    entry.cancelledAt = new Date();
    entry.cancelledBy = req.user?.id;
    entry.cancelReason = String(req.body?.reason || "");
    await entry.save();

    res.json({
      success: true,
      message: "Entry cancelled. It never reached the ledger.",
      entry: withPostingState(entry.toObject()),
    });
  } catch (error) {
    console.error("Error cancelling journal entry:", error);
    res.status(500).json({ success: false, message: "Error cancelling entry" });
  }
});

// VOID journal entry — and take it back out of the books
router.post("/:id/void", async (req, res) => {
  try {
    const entry = await Acc_JournalEntry.findById(req.params.id);
    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });

    /* The voucher goes first. Voiding the entry while its voucher stayed
       posted would leave the balances it moved in place with nothing on this
       page still claiming them. */
    const voided = await voidJournalEntry(entry);
    entry.status = "void";
    entry.cancelledAt = new Date();
    entry.cancelledBy = req.user?.id;
    entry.cancelReason = String(req.body?.reason || "");
    await entry.save();

    res.json({
      success: true,
      message: voided.voidedVoucher
        ? `Entry voided, and voucher ${voided.voucherNumber} reversed out of the ledger.`
        : "Entry voided.",
    });
  } catch (error) {
    console.error("Error voiding journal entry:", error);
    res.status(500).json({ success: false, message: "Error voiding entry" });
  }
});

// DELETE journal entry (draft only)
router.delete("/:id", async (req, res) => {
  try {
    const entry = await Acc_JournalEntry.findById(req.params.id);
    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status !== "draft") {
      return res
        .status(400)
        .json({ success: false, message: "Can only delete draft entries" });
    }
    /* A draft should have no voucher, but if one is linked it is removed from
       the books before the entry goes — a deleted entry must not leave
       balances behind it. */
    if (entry.voucherId) await voidJournalEntry(entry);
    await entry.deleteOne();
    res.json({ success: true, message: "Entry deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting entry" });
  }
});

module.exports = router;
