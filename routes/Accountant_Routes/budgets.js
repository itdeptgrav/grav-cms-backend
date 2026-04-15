// routes/Accountant_Routes/budgets.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { Budget, Expense, ActivityLog } = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// GET all budgets
router.get("/", async (req, res) => {
  try {
    const { financialYear, status, period } = req.query;
    let filter = {};
    if (financialYear) filter.financialYear = financialYear;
    if (status) filter.status = status;
    if (period) filter.period = period;

    const budgets = await Budget.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, budgets });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching budgets" });
  }
});

// GET single budget with actual spending
router.get("/:id", async (req, res) => {
  try {
    const budget = await Budget.findById(req.params.id).lean();
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });

    // Get actual spending for each category
    const expenses = await Expense.find({
      createdAt: { $gte: budget.startDate, $lte: budget.endDate },
      status: { $ne: "void" },
    }).select("category totalAmount").lean();

    const actualByCategory = {};
    expenses.forEach((e) => {
      if (!actualByCategory[e.category]) actualByCategory[e.category] = 0;
      actualByCategory[e.category] += e.totalAmount || 0;
    });

    // Update items with actual spending
    budget.items = budget.items.map((item) => ({
      ...item,
      spentAmount: actualByCategory[item.category] || 0,
      remainingAmount: item.allocatedAmount - (actualByCategory[item.category] || 0),
      variance: item.allocatedAmount - (actualByCategory[item.category] || 0),
      utilizationPct: item.allocatedAmount > 0
        ? parseFloat((((actualByCategory[item.category] || 0) / item.allocatedAmount) * 100).toFixed(1))
        : 0,
    }));

    budget.totalSpent = Object.values(actualByCategory).reduce((s, v) => s + v, 0);
    budget.totalRemaining = budget.totalAllocated - budget.totalSpent;

    res.json({ success: true, budget });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching budget" });
  }
});

// CREATE budget
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    data.createdBy = req.user.id;
    data.totalAllocated = (data.items || []).reduce((s, i) => s + (i.allocatedAmount || 0), 0);
    const budget = await Budget.create(data);
    res.status(201).json({ success: true, budget });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error creating budget" });
  }
});

// UPDATE budget
router.put("/:id", async (req, res) => {
  try {
    const data = req.body;
    if (data.items) {
      data.totalAllocated = data.items.reduce((s, i) => s + (i.allocatedAmount || 0), 0);
    }
    const budget = await Budget.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });
    res.json({ success: true, budget });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating budget" });
  }
});

// DELETE budget
router.delete("/:id", async (req, res) => {
  try {
    await Budget.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Budget deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting budget" });
  }
});

module.exports = router;
