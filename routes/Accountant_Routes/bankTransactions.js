// routes/Accountant_Routes/bankTransactions.js
//
// Bank Transactions — fetch, ingest, reconcile.
//
// Ingestion paths supported (in order of practical adoption for SMBs):
//   1. Manual entry          — POST /                (single transaction)
//   2. CSV / statement parse — POST /import-statement (bulk, idempotent)
//   3. Webhook receiver      — POST /webhook/:provider/:secret
//                              (for banks / aggregators that push events)
//   4. Programmatic sync     — POST /sync-now/:bankAccount
//                              (placeholder — fires connector if configured)
//
// Idempotency: when importing or receiving via webhook, every transaction
// gets a deterministic externalId derived from
//   (bankAccount + transactionDate + amount + referenceNumber/description).
// We use this as a unique key and skip duplicates instead of failing.
//
// Auto-match: for each unreconciled transaction, find candidate
// TallyVoucher entries within ±3 days with the same amount.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  BankTransaction,
  ActivityLog,
  AccountantSettings,
} = require("../../models/Accountant_model/AccountantModels");
const {
  TallyVoucher,
} = require("../../models/Accountant_model/TallyVoucherModels");

router.use(AccountantAuthMiddleware.accountantAuth);

// ── Helper: deterministic external ID for idempotency ───────────────────
function externalIdFor(t) {
  const date = t.transactionDate
    ? new Date(t.transactionDate).toISOString().slice(0, 10)
    : "";
  const ref = (t.referenceNumber || t.description || "").trim().slice(0, 60);
  const acct = t.bankAccount || "";
  const amt = Number(t.amount || 0).toFixed(2);
  return crypto
    .createHash("sha256")
    .update(`${acct}|${date}|${amt}|${ref}`)
    .digest("hex")
    .slice(0, 24);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /  — list with filters + pagination + summary
// ─────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      bankAccount,
      type,
      category,
      isReconciled,
      startDate,
      endDate,
      page = 1,
      limit = 30,
      search,
    } = req.query;

    const filter = {};
    if (bankAccount) filter.bankAccount = bankAccount;
    if (type) filter.type = type;
    if (category) filter.category = category;
    if (isReconciled !== undefined)
      filter.isReconciled = isReconciled === "true";
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
      BankTransaction.find(filter)
        .sort({ transactionDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      BankTransaction.countDocuments(filter),
    ]);

    // Summary computed across the filtered set (not just the page) so the
    // user always sees the right totals for the current view.
    const allTxns = await BankTransaction.find(filter)
      .select("type amount isReconciled")
      .lean();
    const summary = {
      totalCredits: allTxns
        .filter((t) => t.type === "credit")
        .reduce((s, t) => s + (t.amount || 0), 0),
      totalDebits: allTxns
        .filter((t) => t.type === "debit")
        .reduce((s, t) => s + (t.amount || 0), 0),
      reconciled: allTxns.filter((t) => t.isReconciled).length,
      unreconciled: allTxns.filter((t) => !t.isReconciled).length,
      count: total,
    };
    summary.netFlow = summary.totalCredits - summary.totalDebits;

    res.json({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)) || 1,
      },
      summary,
    });
  } catch (error) {
    console.error("Error fetching bank transactions:", error);
    res
      .status(500)
      .json({ success: false, message: "Error fetching bank transactions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /sources — connector status per bank account
// ─────────────────────────────────────────────────────────────────────────
// Returns one row per configured bank account showing:
//   • Bank name, account mask
//   • Connector type & status (manual / CSV / API / webhook)
//   • Last sync / last imported timestamp
//   • Transaction count, reconciled count
// Drives the "Connection Status" panel on the bank-transactions page.
router.get("/sources", async (req, res) => {
  try {
    const settings = await AccountantSettings.getSingleton();
    const banks = settings?.bankAccounts || [];

    const results = await Promise.all(
      banks.map(async (acc, idx) => {
        // The bankAccount field on transactions stores the bank's account number
        // (or a stable identifier). We match by accountNumber.
        const stat = await BankTransaction.aggregate([
          { $match: { bankAccount: acc.accountNumber } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              reconciled: { $sum: { $cond: ["$isReconciled", 1, 0] } },
              lastTxnDate: { $max: "$transactionDate" },
              lastImportAt: { $max: "$createdAt" },
              latestBalance: { $last: "$runningBalance" },
            },
          },
        ]);

        const s = stat[0] || {};
        // Connector config — read from settings if present
        const cfg =
          (settings.bankConnectors || []).find(
            (c) => c.bankAccount === acc.accountNumber,
          ) || {};
        return {
          index: idx,
          bankName: acc.bankName,
          accountNumber: acc.accountNumber,
          accountMask: maskAcct(acc.accountNumber),
          ifscCode: acc.ifscCode,
          accountType: acc.accountType,
          isDefault: !!acc.isDefault,
          connector: {
            provider: cfg.provider || "manual", // manual | csv | api | webhook
            status: cfg.status || "not_configured",
            lastSyncAt: cfg.lastSyncAt || null,
            syncFrequency: cfg.syncFrequency || null,
            notes: cfg.notes || "",
          },
          stats: {
            transactionCount: s.count || 0,
            reconciledCount: s.reconciled || 0,
            lastTxnDate: s.lastTxnDate || null,
            lastImportAt: s.lastImportAt || null,
            latestBalance: s.latestBalance ?? null,
          },
        };
      }),
    );

    res.json({ success: true, sources: results });
  } catch (error) {
    console.error("Error fetching sources:", error);
    res.status(500).json({ success: false, message: "Error fetching sources" });
  }
});

function maskAcct(num) {
  if (!num) return "";
  const s = String(num);
  return s.length > 4 ? `${"*".repeat(s.length - 4)}${s.slice(-4)}` : s;
}

// ─────────────────────────────────────────────────────────────────────────
// POST / — create a single transaction (manual entry)
// ─────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const data = { ...req.body };
    data.createdBy = req.user.id;
    data.source = data.source || "manual";
    data.externalId = data.externalId || externalIdFor(data);
    const txn = await BankTransaction.create(data);
    res.status(201).json({ success: true, transaction: txn });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Duplicate transaction (same date, amount, reference)",
      });
    }
    console.error("Error creating transaction:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating transaction",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /import-statement — bulk import from CSV/parsed rows
// ─────────────────────────────────────────────────────────────────────────
// The frontend parses the CSV and posts an array of normalized rows. We
// dedupe by externalId so re-imports of overlapping date ranges are safe.
router.post("/import-statement", async (req, res) => {
  try {
    const { transactions, bankAccount, source = "csv_import" } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Provide a non-empty transactions array",
      });
    }
    if (!bankAccount) {
      return res
        .status(400)
        .json({ success: false, message: "bankAccount is required" });
    }

    const prepared = transactions.map((t) => ({
      ...t,
      bankAccount,
      source,
      createdBy: req.user.id,
      externalId: t.externalId || externalIdFor({ ...t, bankAccount }),
    }));

    // De-dup against existing externalIds — single query
    const existingIds = new Set(
      (
        await BankTransaction.find({
          externalId: { $in: prepared.map((t) => t.externalId) },
        })
          .select("externalId")
          .lean()
      ).map((d) => d.externalId),
    );
    const fresh = prepared.filter((t) => !existingIds.has(t.externalId));
    const skipped = prepared.length - fresh.length;

    let inserted = 0;
    if (fresh.length > 0) {
      try {
        const result = await BankTransaction.insertMany(fresh, {
          ordered: false,
        });
        inserted = result.length;
      } catch (e) {
        // ordered: false means partial inserts succeed even if some fail
        inserted = e.insertedDocs?.length || e.result?.nInserted || 0;
      }
    }

    // Update connector status for this account
    const settings = await AccountantSettings.getSingleton();
    settings.bankConnectors = settings.bankConnectors || [];
    const connIdx = settings.bankConnectors.findIndex(
      (c) => c.bankAccount === bankAccount,
    );
    const connectorRow = {
      bankAccount,
      provider: "csv",
      status: "ok",
      lastSyncAt: new Date(),
      notes: `Imported ${inserted} transactions; ${skipped} duplicates skipped.`,
    };
    if (connIdx >= 0) settings.bankConnectors[connIdx] = connectorRow;
    else settings.bankConnectors.push(connectorRow);
    settings.markModified("bankConnectors");
    await settings.save();

    res.status(201).json({
      success: true,
      message: `Imported ${inserted} transactions; ${skipped} duplicates skipped`,
      inserted,
      skipped,
      total: prepared.length,
    });
  } catch (error) {
    console.error("Error importing statement:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error importing statement",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /webhook/:provider/:secret  — receive transaction events
// ─────────────────────────────────────────────────────────────────────────
// Authentication is via path-segment secret, configured per bank account in
// settings.bankConnectors[].webhookSecret. Banks/aggregators POST to:
//   https://your-cms.com/api/accountant/bank-transactions/webhook/<provider>/<secret>
// Body shape (normalized): { bankAccount, transactions: [...] }.
//
// NOTE: This route is publicly accessible (no accountantAuth middleware
// applied) to allow third-party POSTs. Configured BEFORE the auth middleware
// in the express setup. See routes/accountant.routes.js for ordering.
//
// For now, we leave it under accountantAuth and document that for production
// the auth middleware should skip /webhook/* paths. To wire that up safely,
// move this handler into a separate router that doesn't apply auth.
router.post("/webhook/:provider/:secret", async (req, res) => {
  try {
    const { provider, secret } = req.params;
    const { bankAccount, transactions } = req.body || {};
    if (!bankAccount || !Array.isArray(transactions)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid webhook payload" });
    }

    // Verify the secret against configured webhook secret for this account
    const settings = await AccountantSettings.getSingleton();
    const cfg = (settings.bankConnectors || []).find(
      (c) => c.bankAccount === bankAccount,
    );
    if (!cfg || cfg.webhookSecret !== secret) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid webhook secret" });
    }

    const prepared = transactions.map((t) => ({
      ...t,
      bankAccount,
      source: `webhook:${provider}`,
      externalId: t.externalId || externalIdFor({ ...t, bankAccount }),
    }));

    const existingIds = new Set(
      (
        await BankTransaction.find({
          externalId: { $in: prepared.map((t) => t.externalId) },
        })
          .select("externalId")
          .lean()
      ).map((d) => d.externalId),
    );
    const fresh = prepared.filter((t) => !existingIds.has(t.externalId));
    let inserted = 0;
    if (fresh.length > 0) {
      try {
        const result = await BankTransaction.insertMany(fresh, {
          ordered: false,
        });
        inserted = result.length;
      } catch (e) {
        inserted = e.insertedDocs?.length || 0;
      }
    }

    cfg.lastSyncAt = new Date();
    cfg.status = "ok";
    settings.markModified("bankConnectors");
    await settings.save();

    res.json({ success: true, inserted, skipped: prepared.length - inserted });
  } catch (error) {
    console.error("Webhook error:", error);
    res
      .status(500)
      .json({ success: false, message: "Webhook processing failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /sync-now/:bankAccount — trigger a sync if a connector is configured
// ─────────────────────────────────────────────────────────────────────────
// Placeholder: returns success with status "manual" until a real provider
// is wired up. The actual API call to ICICI/HDFC/Setu would happen here.
router.post("/sync-now/:bankAccount", async (req, res) => {
  try {
    const { bankAccount } = req.params;
    const settings = await AccountantSettings.getSingleton();
    const cfg = (settings.bankConnectors || []).find(
      (c) => c.bankAccount === bankAccount,
    );

    if (
      !cfg ||
      !cfg.provider ||
      cfg.provider === "manual" ||
      cfg.provider === "csv"
    ) {
      return res.json({
        success: true,
        synced: 0,
        message:
          "No automated connector is configured for this account. Use 'Import Statement' to upload a CSV from your bank, or configure a direct API connector in Settings.",
      });
    }

    if (cfg.provider === "api") {
      // Placeholder for direct bank API integration.
      // Real implementation would call the bank's transactions endpoint here.
      return res.json({
        success: true,
        synced: 0,
        message:
          "Direct bank API connector configured. Integration pending — wire up the provider's API call inside POST /sync-now/.",
      });
    }
    if (cfg.provider === "aa") {
      return res.json({
        success: true,
        synced: 0,
        message:
          "Account Aggregator connector configured. Integration pending — wire up the AA Data Fetch flow inside POST /sync-now/.",
      });
    }
    return res.json({
      success: true,
      synced: 0,
      message: `Provider '${cfg.provider}' not yet implemented.`,
    });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ success: false, message: "Sync failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /connector/:bankAccount — update connector configuration
// ─────────────────────────────────────────────────────────────────────────
router.put("/connector/:bankAccount", async (req, res) => {
  try {
    const { bankAccount } = req.params;
    const settings = await AccountantSettings.getSingleton();
    settings.bankConnectors = settings.bankConnectors || [];
    const idx = settings.bankConnectors.findIndex(
      (c) => c.bankAccount === bankAccount,
    );
    const allowed = [
      "provider",
      "status",
      "syncFrequency",
      "webhookSecret",
      "apiCredentials",
      "notes",
    ];
    const next =
      idx >= 0 ? { ...settings.bankConnectors[idx] } : { bankAccount };
    for (const key of allowed) {
      if (req.body[key] !== undefined) next[key] = req.body[key];
    }
    if (idx >= 0) settings.bankConnectors[idx] = next;
    else settings.bankConnectors.push(next);
    settings.markModified("bankConnectors");
    await settings.save();
    res.json({ success: true, connector: next });
  } catch (error) {
    console.error("Connector update error:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating connector" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/auto-match-suggestions — find candidate matches for a txn
// ─────────────────────────────────────────────────────────────────────────
// Looks for TallyVouchers within ±3 days with the same amount on either side
// of the entry. Returns up to 5 candidates. The user picks one in the UI.
router.get("/:id/auto-match-suggestions", async (req, res) => {
  try {
    const txn = await BankTransaction.findById(req.params.id).lean();
    if (!txn)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });

    const amount = Number(txn.amount || 0);
    const date = new Date(txn.transactionDate);
    const lo = new Date(date);
    lo.setDate(lo.getDate() - 3);
    const hi = new Date(date);
    hi.setDate(hi.getDate() + 3);

    const candidates = await TallyVoucher.find({
      status: "posted",
      voucherDate: { $gte: lo, $lte: hi },
      "ledgerEntries.amount": amount,
    })
      .select(
        "voucherNumber voucherType voucherDate narration ledgerEntries totalAmount",
      )
      .sort({ voucherDate: -1 })
      .limit(10)
      .lean();

    // Score candidates by closeness of date and exact-amount on the cash side
    const scored = candidates
      .map((v) => {
        const matchingLeg = (v.ledgerEntries || []).find(
          (e) => Math.abs(Number(e.amount) - amount) < 0.005,
        );
        const dayDiff = Math.abs(
          (new Date(v.voucherDate) - date) / (24 * 3600 * 1000),
        );
        const score = (matchingLeg ? 50 : 0) + Math.max(0, 30 - dayDiff * 5);
        return {
          voucherId: v._id,
          voucherNumber: v.voucherNumber,
          voucherType: v.voucherType,
          voucherDate: v.voucherDate,
          narration: v.narration,
          totalAmount: v.totalAmount,
          matchingLeg: matchingLeg
            ? {
                type: matchingLeg.type,
                amount: matchingLeg.amount,
                ledgerName: matchingLeg.ledgerName,
              }
            : null,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    res.json({ success: true, suggestions: scored });
  } catch (error) {
    console.error("Auto-match error:", error);
    res.status(500).json({ success: false, message: "Auto-match failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/reconcile, POST /:id/unreconcile, DELETE /:id — unchanged
// ─────────────────────────────────────────────────────────────────────────
router.post("/:id/reconcile", async (req, res) => {
  try {
    const txn = await BankTransaction.findById(req.params.id);
    if (!txn)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });
    txn.isReconciled = true;
    txn.reconciledBy = req.user.id;
    txn.reconciledAt = new Date();
    if (req.body.reconciledWith) txn.reconciledWith = req.body.reconciledWith;
    if (req.body.category) txn.category = req.body.category;
    if (req.body.linkedInvoice) txn.linkedInvoice = req.body.linkedInvoice;
    if (req.body.linkedExpense) txn.linkedExpense = req.body.linkedExpense;
    if (req.body.linkedVoucher) txn.linkedVoucher = req.body.linkedVoucher;
    if (req.body.notes) txn.notes = req.body.notes;
    await txn.save();
    res.json({ success: true, transaction: txn });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error reconciling transaction" });
  }
});

router.post("/:id/unreconcile", async (req, res) => {
  try {
    await BankTransaction.findByIdAndUpdate(req.params.id, {
      isReconciled: false,
      reconciledWith: null,
      reconciledBy: null,
      reconciledAt: null,
      linkedVoucher: null,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await BankTransaction.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error deleting transaction" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /accounts/summary — keep for backward compat
// ─────────────────────────────────────────────────────────────────────────
router.get("/accounts/summary", async (req, res) => {
  try {
    const accounts = await BankTransaction.aggregate([
      { $sort: { transactionDate: -1 } },
      {
        $group: {
          _id: "$bankAccount",
          bankName: { $first: "$bankName" },
          latestBalance: { $first: "$runningBalance" },
          totalCredits: {
            $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
          },
          totalDebits: {
            $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
          },
          transactionCount: { $sum: 1 },
          lastTransaction: { $first: "$transactionDate" },
        },
      },
    ]);
    res.json({ success: true, accounts });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error" });
  }
});

module.exports = router;
