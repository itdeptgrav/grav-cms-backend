// routes/Accountant_Routes/taxFilings.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { TaxFiling, ActivityLog } = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// GET all tax filings
router.get("/", async (req, res) => {
  try {
    const { taxType, status, financialYear } = req.query;
    let filter = {};
    if (taxType) filter.taxType = taxType;
    if (status) filter.status = status;
    if (financialYear) filter.financialYear = financialYear;

    const filings = await TaxFiling.find(filter).sort({ dueDate: -1 }).lean();

    const summary = {
      total: filings.length,
      pending: filings.filter((f) => f.status === "pending").length,
      filed: filings.filter((f) => f.status === "filed").length,
      overdue: filings.filter((f) => f.status === "overdue").length,
      totalPayable: filings.reduce((s, f) => s + (f.totalPayable || 0), 0),
      totalPaid: filings.reduce((s, f) => s + (f.amountPaid || 0), 0),
    };

    res.json({ success: true, filings, summary });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching tax filings" });
  }
});

// CREATE tax filing
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    data.createdBy = req.user.id;
    const filing = await TaxFiling.create(data);
    res.status(201).json({ success: true, filing });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error creating tax filing" });
  }
});

// UPDATE tax filing
router.put("/:id", async (req, res) => {
  try {
    const filing = await TaxFiling.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!filing) return res.status(404).json({ success: false, message: "Filing not found" });
    res.json({ success: true, filing });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating tax filing" });
  }
});

// MARK as filed
router.post("/:id/file", async (req, res) => {
  try {
    const filing = await TaxFiling.findById(req.params.id);
    if (!filing) return res.status(404).json({ success: false, message: "Filing not found" });

    filing.status = "filed";
    filing.filingDate = new Date();
    filing.filedBy = req.user.id;
    if (req.body.acknowledgementNumber) filing.acknowledgementNumber = req.body.acknowledgementNumber;
    if (req.body.challanNumber) filing.challanNumber = req.body.challanNumber;
    await filing.save();

    res.json({ success: true, message: "Tax filing marked as filed", filing });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error filing tax" });
  }
});

// GET upcoming tax deadlines
router.get("/deadlines", async (req, res) => {
  try {
    const today = new Date();
    const threeMonthsLater = new Date();
    threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);

    const deadlines = await TaxFiling.find({
      dueDate: { $gte: today, $lte: threeMonthsLater },
      status: { $in: ["upcoming", "pending"] },
    })
      .sort({ dueDate: 1 })
      .lean();

    res.json({ success: true, deadlines });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching deadlines" });
  }
});

module.exports = router;
