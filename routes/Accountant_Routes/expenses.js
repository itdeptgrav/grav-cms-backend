// routes/Accountant_Routes/expenses.js
// Complete Expense Management Routes

const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { Expense, ActivityLog } = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// Helper: get financial year string
const getFinancialYear = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${year}-${(year + 1).toString().slice(2)}`;
};

// ── GET all expenses with filters ──
router.get("/", async (req, res) => {
  try {
    const {
      page = 1, limit = 20, category, status, paymentStatus,
      startDate, endDate, search, sortBy = "createdAt", sortOrder = "desc",
      financialYear,
    } = req.query;

    let filter = {};
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (financialYear) filter.financialYear = financialYear;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    if (search) {
      filter.$or = [
        { description: { $regex: search, $options: "i" } },
        { expenseId: { $regex: search, $options: "i" } },
        { vendorName: { $regex: search, $options: "i" } },
        { referenceNumber: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortObj = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const [expenses, total] = await Promise.all([
      Expense.find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(parseInt(limit))
        .populate("vendorId", "companyName")
        .populate("createdBy", "name")
        .lean(),
      Expense.countDocuments(filter),
    ]);

    // Summary stats
    const allExpenses = await Expense.find(filter).select("totalAmount paymentStatus category").lean();
    const summary = {
      totalAmount: allExpenses.reduce((s, e) => s + (e.totalAmount || 0), 0),
      totalPending: allExpenses.filter((e) => e.paymentStatus === "pending").reduce((s, e) => s + (e.totalAmount || 0), 0),
      totalPaid: allExpenses.filter((e) => e.paymentStatus === "paid").reduce((s, e) => s + (e.totalAmount || 0), 0),
      count: total,
      byCategory: {},
    };

    allExpenses.forEach((e) => {
      if (!summary.byCategory[e.category]) summary.byCategory[e.category] = 0;
      summary.byCategory[e.category] += e.totalAmount || 0;
    });

    res.json({
      success: true,
      expenses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
      summary,
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ success: false, message: "Error fetching expenses" });
  }
});

// ── GET single expense ──
router.get("/:id", async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id)
      .populate("vendorId", "companyName contactPerson email phone")
      .populate("createdBy", "name email")
      .populate("approvedBy", "name email")
      .lean();

    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    res.json({ success: true, expense });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching expense" });
  }
});

// ── CREATE expense ──
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    data.createdBy = req.user.id;
    data.financialYear = getFinancialYear(data.paymentDate || new Date());

    // Auto-calculate total
    if (data.amount && data.gstApplicable && data.gstDetails?.gstRate) {
      const gstAmt = (data.amount * data.gstDetails.gstRate) / 100;
      data.taxAmount = gstAmt;
      data.totalAmount = data.amount + gstAmt;

      // Split GST
      if (data.gstDetails.gstRate) {
        data.gstDetails.cgst = gstAmt / 2;
        data.gstDetails.sgst = gstAmt / 2;
      }
    } else {
      data.totalAmount = data.totalAmount || data.amount;
    }

    // TDS calculation
    if (data.tdsApplicable && data.tdsDetails?.tdsRate) {
      data.tdsDetails.tdsAmount = (data.amount * data.tdsDetails.tdsRate) / 100;
    }

    const expense = await Expense.create(data);

    // Log activity
    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Created expense",
      module: "expense",
      entityType: "Expense",
      entityId: expense._id,
      details: `Created expense ${expense.expenseId} - ₹${expense.totalAmount}`,
    });

    res.status(201).json({ success: true, message: "Expense created", expense });
  } catch (error) {
    console.error("Error creating expense:", error);
    res.status(500).json({ success: false, message: "Error creating expense" });
  }
});

// ── UPDATE expense ──
router.put("/:id", async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    if (expense.status === "approved") {
      return res.status(400).json({ success: false, message: "Cannot edit approved expense" });
    }

    const data = req.body;
    data.updatedBy = req.user.id;

    // Recalculate totals
    if (data.amount !== undefined) {
      if (data.gstApplicable && data.gstDetails?.gstRate) {
        const gstAmt = (data.amount * data.gstDetails.gstRate) / 100;
        data.taxAmount = gstAmt;
        data.totalAmount = data.amount + gstAmt;
        data.gstDetails.cgst = gstAmt / 2;
        data.gstDetails.sgst = gstAmt / 2;
      } else {
        data.totalAmount = data.totalAmount || data.amount;
      }
    }

    const updated = await Expense.findByIdAndUpdate(req.params.id, data, { new: true });

    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Updated expense",
      module: "expense",
      entityType: "Expense",
      entityId: updated._id,
      details: `Updated expense ${updated.expenseId}`,
    });

    res.json({ success: true, message: "Expense updated", expense: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating expense" });
  }
});

// ── APPROVE expense ──
router.post("/:id/approve", async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    expense.status = "approved";
    expense.approvedBy = req.user.id;
    expense.approvedAt = new Date();
    await expense.save();

    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Approved expense",
      module: "expense",
      entityType: "Expense",
      entityId: expense._id,
      details: `Approved expense ${expense.expenseId} - ₹${expense.totalAmount}`,
    });

    res.json({ success: true, message: "Expense approved" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error approving expense" });
  }
});

// ── REJECT expense ──
router.post("/:id/reject", async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    expense.status = "rejected";
    expense.rejectionReason = req.body.reason || "";
    await expense.save();

    res.json({ success: true, message: "Expense rejected" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error rejecting expense" });
  }
});

// ── DELETE expense ──
router.delete("/:id", async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    if (expense.status === "approved") {
      return res.status(400).json({ success: false, message: "Cannot delete approved expense" });
    }

    await expense.deleteOne();
    res.json({ success: true, message: "Expense deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting expense" });
  }
});

// ── GET expense analytics ──
router.get("/analytics/summary", async (req, res) => {
  try {
    const { period = "monthly", year } = req.query;
    const currentYear = year || new Date().getFullYear();

    const pipeline = [
      {
        $match: {
          status: { $ne: "void" },
          createdAt: {
            $gte: new Date(currentYear, 0, 1),
            $lte: new Date(currentYear, 11, 31),
          },
        },
      },
      {
        $group: {
          _id: {
            month: { $month: "$createdAt" },
            category: "$category",
          },
          total: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.month": 1 } },
    ];

    const result = await Expense.aggregate(pipeline);

    res.json({ success: true, analytics: result });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching analytics" });
  }
});

module.exports = router;
