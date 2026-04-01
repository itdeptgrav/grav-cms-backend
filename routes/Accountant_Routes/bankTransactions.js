// routes/Accountant_Routes/bankTransactions.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { BankTransaction, ActivityLog } = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// GET all bank transactions
router.get("/", async (req, res) => {
  try {
    const { bankAccount, type, category, isReconciled, startDate, endDate, page = 1, limit = 30, search } = req.query;
    let filter = {};
    if (bankAccount) filter.bankAccount = bankAccount;
    if (type) filter.type = type;
    if (category) filter.category = category;
    if (isReconciled !== undefined) filter.isReconciled = isReconciled === "true";
    if (search) {
      filter.$or = [
        { description: { $regex: search, $options: "i" } },
        { referenceNumber: { $regex: search, $options: "i" } },
        { transactionId: { $regex: search, $options: "i" } },
      ];
    }
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [transactions, total] = await Promise.all([
      BankTransaction.find(filter).sort({ transactionDate: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      BankTransaction.countDocuments(filter),
    ]);

    // Summary
    const allTxns = await BankTransaction.find(filter).select("type amount isReconciled").lean();
    const summary = {
      totalCredits: allTxns.filter((t) => t.type === "credit").reduce((s, t) => s + t.amount, 0),
      totalDebits: allTxns.filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0),
      reconciled: allTxns.filter((t) => t.isReconciled).length,
      unreconciled: allTxns.filter((t) => !t.isReconciled).length,
      count: total,
    };

    res.json({
      success: true,
      transactions,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
      summary,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching bank transactions" });
  }
});

// CREATE bank transaction
router.post("/", async (req, res) => {
  try {
    const data = req.body;
    data.createdBy = req.user.id;
    const txn = await BankTransaction.create(data);
    res.status(201).json({ success: true, transaction: txn });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error creating transaction" });
  }
});

// BULK import transactions
router.post("/bulk-import", async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ success: false, message: "Transactions array required" });
    }

    const prepared = transactions.map((t) => ({ ...t, createdBy: req.user.id }));
    const result = await BankTransaction.insertMany(prepared, { ordered: false });

    res.status(201).json({ success: true, message: `${result.length} transactions imported`, count: result.length });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error importing transactions" });
  }
});

// RECONCILE transaction
router.post("/:id/reconcile", async (req, res) => {
  try {
    const txn = await BankTransaction.findById(req.params.id);
    if (!txn) return res.status(404).json({ success: false, message: "Transaction not found" });

    txn.isReconciled = true;
    txn.reconciledBy = req.user.id;
    txn.reconciledAt = new Date();
    if (req.body.reconciledWith) txn.reconciledWith = req.body.reconciledWith;
    if (req.body.category) txn.category = req.body.category;
    if (req.body.linkedInvoice) txn.linkedInvoice = req.body.linkedInvoice;
    if (req.body.linkedExpense) txn.linkedExpense = req.body.linkedExpense;
    await txn.save();

    res.json({ success: true, message: "Transaction reconciled" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error reconciling transaction" });
  }
});

// UN-RECONCILE
router.post("/:id/unreconcile", async (req, res) => {
  try {
    await BankTransaction.findByIdAndUpdate(req.params.id, {
      isReconciled: false,
      reconciledWith: null,
      reconciledBy: null,
      reconciledAt: null,
    });
    res.json({ success: true, message: "Reconciliation removed" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error" });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    await BankTransaction.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Transaction deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting transaction" });
  }
});

// GET bank accounts summary
router.get("/accounts/summary", async (req, res) => {
  try {
    const pipeline = [
      { $sort: { transactionDate: -1 } },
      {
        $group: {
          _id: "$bankAccount",
          bankName: { $first: "$bankName" },
          latestBalance: { $first: "$runningBalance" },
          totalCredits: { $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] } },
          totalDebits: { $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] } },
          transactionCount: { $sum: 1 },
          lastTransaction: { $first: "$transactionDate" },
        },
      },
    ];

    const accounts = await BankTransaction.aggregate(pipeline);
    res.json({ success: true, accounts });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching account summary" });
  }
});

module.exports = router;
