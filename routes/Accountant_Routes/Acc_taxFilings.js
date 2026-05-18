// routes/Accountant_Routes/Acc_taxFilings.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_TaxFiling,
  ActivityLog,
} = require("../../models/Accountant_model/Acc_OperationalModels");

router.use(AccountantAuthMiddleware.accountantAuth);

// ── Helper: derive effective status ──────────────────────────────────────
// If a filing's dueDate has passed and it's still in pending/upcoming, treat
// it as overdue at read-time. We don't mutate the DB — the underlying status
// is preserved so the user can see what they entered. The derived status is
// what drives KPIs and the UI badge.
function effectiveStatus(filing, today = new Date()) {
  if (filing.status === "filed" || filing.status === "paid")
    return filing.status;
  if (filing.dueDate && new Date(filing.dueDate) < today) return "overdue";
  return filing.status || "pending";
}

// ── GET all tax filings with summary KPIs ────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { taxType, status, financialYear } = req.query;
    const filter = {};
    if (taxType) filter.taxType = taxType;
    if (financialYear) filter.financialYear = financialYear;

    const allFilings = await Acc_TaxFiling.find(
      Object.keys(filter).length ? filter : {},
    )
      .sort({ dueDate: -1 })
      .lean();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Attach effective status to each filing
    const enriched = allFilings.map((f) => ({
      ...f,
      effectiveStatus: effectiveStatus(f, today),
      daysToDue: f.dueDate
        ? Math.floor((new Date(f.dueDate) - today) / (1000 * 60 * 60 * 24))
        : null,
    }));

    // Apply status filter on effective status (so "overdue" filter works)
    const filings = status
      ? enriched.filter((f) => f.effectiveStatus === status)
      : enriched;

    // ── Build summary KPIs ────────────────────────────────────────────
    // Compute on `enriched` (full set) so KPIs reflect the company state, not
    // just the current filter view.
    const oneWeekAhead = new Date(today);
    oneWeekAhead.setDate(oneWeekAhead.getDate() + 7);
    const oneMonthAhead = new Date(today);
    oneMonthAhead.setMonth(oneMonthAhead.getMonth() + 1);

    const summary = {
      total: enriched.length,
      pending: enriched.filter(
        (f) =>
          f.effectiveStatus === "pending" || f.effectiveStatus === "upcoming",
      ).length,
      filed: enriched.filter(
        (f) => f.effectiveStatus === "filed" || f.effectiveStatus === "paid",
      ).length,
      overdue: enriched.filter((f) => f.effectiveStatus === "overdue").length,
      dueThisWeek: enriched.filter(
        (f) =>
          (f.effectiveStatus === "pending" ||
            f.effectiveStatus === "upcoming") &&
          f.dueDate &&
          new Date(f.dueDate) <= oneWeekAhead &&
          new Date(f.dueDate) >= today,
      ).length,
      dueThisMonth: enriched.filter(
        (f) =>
          (f.effectiveStatus === "pending" ||
            f.effectiveStatus === "upcoming") &&
          f.dueDate &&
          new Date(f.dueDate) <= oneMonthAhead &&
          new Date(f.dueDate) >= today,
      ).length,
      totalPayable: enriched.reduce((s, f) => s + (f.totalPayable || 0), 0),
      totalPaid: enriched.reduce((s, f) => s + (f.amountPaid || 0), 0),
      totalOutstanding: enriched.reduce(
        (s, f) => s + Math.max(0, (f.totalPayable || 0) - (f.amountPaid || 0)),
        0,
      ),
    };

    res.json({ success: true, filings, summary });
  } catch (error) {
    console.error("Error fetching tax filings:", error);
    res
      .status(500)
      .json({ success: false, message: "Error fetching tax filings" });
  }
});

// ── CREATE tax filing ────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const data = { ...req.body };
    data.createdBy = req.user.id;
    if (!data.status) data.status = "pending";
    const filing = await Acc_TaxFiling.create(data);
    res.status(201).json({ success: true, filing });
  } catch (error) {
    console.error("Error creating tax filing:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating tax filing",
    });
  }
});

// ── UPDATE tax filing ────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const filing = await Acc_TaxFiling.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!filing)
      return res
        .status(404)
        .json({ success: false, message: "Filing not found" });
    res.json({ success: true, filing });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error updating tax filing" });
  }
});

// ── DELETE tax filing ────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const filing = await Acc_TaxFiling.findByIdAndDelete(req.params.id);
    if (!filing)
      return res
        .status(404)
        .json({ success: false, message: "Filing not found" });
    res.json({ success: true });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error deleting tax filing" });
  }
});

// ── MARK as filed ────────────────────────────────────────────────────────
router.post("/:id/file", async (req, res) => {
  try {
    const filing = await Acc_TaxFiling.findById(req.params.id);
    if (!filing)
      return res
        .status(404)
        .json({ success: false, message: "Filing not found" });

    filing.status = "filed";
    filing.filingDate = req.body.filingDate
      ? new Date(req.body.filingDate)
      : new Date();
    filing.filedBy = req.user.id;
    if (req.body.acknowledgementNumber)
      filing.acknowledgementNumber = req.body.acknowledgementNumber;
    if (req.body.challanNumber) filing.challanNumber = req.body.challanNumber;
    if (req.body.amountPaid != null)
      filing.amountPaid = Number(req.body.amountPaid);
    await filing.save();

    res.json({ success: true, message: "Tax filing marked as filed", filing });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error filing tax" });
  }
});

// ── GET upcoming tax deadlines (next 90 days) ────────────────────────────
router.get("/deadlines", async (req, res) => {
  try {
    const today = new Date();
    const ahead = new Date();
    ahead.setMonth(ahead.getMonth() + 3);

    const deadlines = await Acc_TaxFiling.find({
      dueDate: { $gte: today, $lte: ahead },
      status: { $in: ["upcoming", "pending"] },
    })
      .sort({ dueDate: 1 })
      .lean();

    res.json({ success: true, deadlines });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error fetching deadlines" });
  }
});

module.exports = router;
