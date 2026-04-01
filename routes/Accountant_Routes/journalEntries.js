// routes/Accountant_Routes/journalEntries.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { JournalEntry, ActivityLog } = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// GET all journal entries
router.get("/", async (req, res) => {
  try {
    const { status, type, sourceType, startDate, endDate, page = 1, limit = 20, search } = req.query;
    let filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (sourceType) filter.sourceType = sourceType;
    if (search) {
      filter.$or = [
        { narration: { $regex: search, $options: "i" } },
        { entryNumber: { $regex: search, $options: "i" } },
      ];
    }
    if (startDate || endDate) {
      filter.entryDate = {};
      if (startDate) filter.entryDate.$gte = new Date(startDate);
      if (endDate) filter.entryDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [entries, total] = await Promise.all([
      JournalEntry.find(filter)
        .sort({ entryDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("createdBy", "name")
        .lean(),
      JournalEntry.countDocuments(filter),
    ]);

    res.json({
      success: true,
      entries,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching journal entries" });
  }
});

// GET single entry
router.get("/:id", async (req, res) => {
  try {
    const entry = await JournalEntry.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("postedBy", "name email")
      .lean();
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    res.json({ success: true, entry });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching entry" });
  }
});

// CREATE journal entry
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    data.createdBy = req.user.id;

    // Calculate totals
    data.totalDebit = (data.lines || []).reduce((s, l) => s + (l.debit || 0), 0);
    data.totalCredit = (data.lines || []).reduce((s, l) => s + (l.credit || 0), 0);

    // Validate debit = credit
    if (Math.abs(data.totalDebit - data.totalCredit) > 0.01) {
      return res.status(400).json({ success: false, message: "Total debit must equal total credit" });
    }

    const entry = await JournalEntry.create(data);
    res.status(201).json({ success: true, entry });
  } catch (error) {
    console.error("Error creating journal entry:", error);
    res.status(500).json({ success: false, message: error.message || "Error creating journal entry" });
  }
});

// POST journal entry (change status to posted)
router.post("/:id/post", async (req, res) => {
  try {
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status !== "draft") {
      return res.status(400).json({ success: false, message: "Only draft entries can be posted" });
    }

    entry.status = "posted";
    entry.postedBy = req.user.id;
    entry.postedAt = new Date();
    await entry.save();

    res.json({ success: true, message: "Journal entry posted", entry });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error posting entry" });
  }
});

// VOID journal entry
router.post("/:id/void", async (req, res) => {
  try {
    const entry = await JournalEntry.findByIdAndUpdate(req.params.id, { status: "void" }, { new: true });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    res.json({ success: true, message: "Journal entry voided" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error voiding entry" });
  }
});

// DELETE journal entry (draft only)
router.delete("/:id", async (req, res) => {
  try {
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status !== "draft") {
      return res.status(400).json({ success: false, message: "Can only delete draft entries" });
    }
    await entry.deleteOne();
    res.json({ success: true, message: "Entry deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting entry" });
  }
});

module.exports = router;
