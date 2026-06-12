// routes/Accountant_Routes/Acc_bankRecon.js
// =============================================================================
// BANK RECONCILIATION
// -----------------------------------------------------------------------------
// Upload a bank statement (XLS/XLSX/CSV from Indian Bank / any bank), parse it,
// auto-match transactions against the chart-of-accounts ledger, and persist
// the session so the accountant can review and manually match later.
//
// ENDPOINTS (all mounted at /api/accountant/bank-recon):
//   POST   /upload            → upload + parse + auto-match + save session
//   GET    /sessions          → list sessions for a company
//   GET    /sessions/:id      → full session with comparison data
//   GET    /sessions/:id/comparison → bank vs ledger side-by-side
//   PUT    /sessions/:id/match    → manually match a bank txn to a voucher
//   PUT    /sessions/:id/unmatch  → clear a match
//   DELETE /sessions/:id      → delete session
// =============================================================================

"use strict";

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const XLSX = require("xlsx");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");

const router = express.Router();
router.use(accountantAuth);

// ─── Multer ─────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    if (!ok) return cb(new Error("Only .xlsx, .xls, .csv files are accepted"));
    cb(null, true);
  },
});

// ─── Inline model ────────────────────────────────────────────────────────────
const txnSchema = new mongoose.Schema(
  {
    valueDate: Date,
    postDate: Date,
    description: { type: String, trim: true },
    chequeNo: { type: String, trim: true },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    balanceSuffix: { type: String, default: "CR" },
    branch: { type: String, trim: true },
    // Reconciliation state
    matched: { type: Boolean, default: false },
    matchedVoucherId: { type: mongoose.Types.ObjectId },
    matchedVoucherNumber: String,
    matchedVoucherType: String,
    reconciled: { type: Boolean, default: false },
    note: { type: String, trim: true },
  },
  { _id: true },
);

const sessionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    bankLedgerId: { type: mongoose.Types.ObjectId, ref: "Acc_Ledger" },
    bankLedgerName: String,
    // Statement metadata
    accountNumber: String,
    bankName: String,
    ifscCode: String,
    branch: String,
    periodFrom: Date,
    periodTo: Date,
    openingBalance: Number,
    closingBalance: Number,
    // Summary counts (denormalised for fast list)
    totalCredits: { type: Number, default: 0 },
    totalDebits: { type: Number, default: 0 },
    txnCount: { type: Number, default: 0 },
    matchedCount: { type: Number, default: 0 },
    unmatchedCount: { type: Number, default: 0 },
    // File info
    filename: String,
    filesize: Number,
    status: {
      type: String,
      enum: ["pending", "in_progress", "reconciled"],
      default: "pending",
    },
    transactions: [txnSchema],
  },
  { timestamps: true, collection: "acc_bank_recon_sessions" },
);

const Acc_BankReconSession =
  mongoose.models.Acc_BankReconSession ||
  mongoose.model("Acc_BankReconSession", sessionSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Statement parser
// ─────────────────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // DD/MM/YYYY
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1)
    return new Date(
      `${m1[3]}-${m1[2].padStart(2, "0")}-${m1[1].padStart(2, "0")}T00:00:00.000+05:30`,
    );
  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T00:00:00.000+05:30`);
  // Excel serial date
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(parseFloat(s));
    if (d)
      return new Date(
        `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}T00:00:00.000+05:30`,
      );
  }
  return null;
}

function parseAmt(v) {
  if (v === null || v === undefined || v === "") return 0;
  return parseFloat(String(v).replace(/,/g, "").trim()) || 0;
}

function parseBalStr(s) {
  // e.g. "2604423.68CR" or "123.45DR"
  const m = String(s || "").match(/([\d,]+\.?\d*)\s*(CR|DR)?/i);
  if (!m) return { amount: 0, suffix: "CR" };
  return {
    amount: parseFloat(m[1].replace(/,/g, "")) || 0,
    suffix: (m[2] || "CR").toUpperCase(),
  };
}

function parseBankStatement(buffer, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  let workbook;
  if (ext === "csv") {
    workbook = XLSX.read(buffer, { type: "buffer", raw: true });
  } else {
    workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: false,
      cellText: true,
      raw: true,
    });
  }

  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: false,
  });

  // ── Extract header metadata ────────────────────────────────────────────
  const meta = {
    bankName: "",
    accountNumber: "",
    ifscCode: "",
    branch: "",
    periodFrom: null,
    periodTo: null,
    closingBalance: null,
    openingBalance: null,
  };

  let headerRowIdx = -1;

  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const row = rows[i];
    const cells = row.map((c) => String(c || "").trim());
    const line = cells.join(" ").trim();

    if (!line) continue;

    // Detect the data header row
    if (
      cells.some(
        (c) =>
          /value\s*date/i.test(c) ||
          (c.toLowerCase() === "date" &&
            cells.some((x) => /debit|credit/i.test(x))),
      )
    ) {
      headerRowIdx = i;
      break;
    }

    // Bank name (all-caps word on its own)
    if (
      !meta.bankName &&
      /BANK|FINANCIAL|COOPERATIVE|GRAMIN|MAHILA/i.test(line) &&
      line.length < 60
    ) {
      meta.bankName = line;
    }

    // Account number
    const acctM = line.match(/account\s*(?:number|no)?\s*[:.]\s*(\d{6,20})/i);
    if (acctM) meta.accountNumber = acctM[1];

    // IFSC
    const ifscM = line.match(
      /IFSC\s*(?:CODE)?\s*[:.]\s*([A-Z]{4}0[A-Z0-9]{6})/i,
    );
    if (ifscM) meta.ifscCode = ifscM[1];

    // Branch
    const branchM = line.match(/Branch\s*[:.]\s*(.+)/i);
    if (branchM && !meta.branch)
      meta.branch = branchM[1].trim().substring(0, 60);

    // Statement period
    const periodM = line.match(
      /from\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\s+to\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i,
    );
    if (periodM) {
      meta.periodFrom = parseDate(periodM[1].replace(/-/g, "/"));
      meta.periodTo = parseDate(periodM[2].replace(/-/g, "/"));
    }

    // Cleared balance
    const clearM = line.match(/cleared\s+balance\s*[:.]\s*([\d,]+\.?\d*)/i);
    if (clearM) meta.closingBalance = parseFloat(clearM[1].replace(/,/g, ""));
  }

  if (headerRowIdx === -1) {
    throw new Error(
      "Could not find transaction header row. Make sure the file has columns like 'Value Date', 'Debit Amount', 'Credit Amount'.",
    );
  }

  // ── Map column indices ─────────────────────────────────────────────────
  const headers = rows[headerRowIdx].map((c) =>
    String(c || "")
      .trim()
      .toLowerCase(),
  );
  const col = (patterns) => {
    for (const p of patterns) {
      const idx = headers.findIndex((h) => p.test(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const colValueDate = col([/value\s*date/, /txn\s*date/, /^date$/]);
  const colPostDate = col([/post\s*date/, /transaction\s*date/]);
  const colDesc = col([
    /description/,
    /narration/,
    /particulars/,
    /remarks/,
    /details/,
  ]);
  const colCheque = col([/cheque/, /chq/, /ref\s*no/, /reference/]);
  const colDebit = col([/debit\s*amount/, /withdrawal/, /debit/, /dr/]);
  const colCredit = col([/credit\s*amount/, /deposit/, /credit/, /cr/]);
  const colBalance = col([/balance/]);
  const colBranch = col([/remitter\s*branch/, /branch/, /remitter/]);

  if (colDesc === -1 || (colDebit === -1 && colCredit === -1)) {
    throw new Error(
      "Could not identify Description and Debit/Credit columns in the statement.",
    );
  }

  // ── Parse transactions ─────────────────────────────────────────────────
  const transactions = [];
  let openingBalance = null;

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !String(c).trim())) continue;

    const desc = colDesc !== -1 ? String(row[colDesc] || "").trim() : "";
    if (!desc) continue;

    // Skip footer/total rows
    if (
      /^(total|end\s*of|statement\s*downloaded|unless|immediately|\*|#)/i.test(
        desc,
      )
    )
      continue;

    // Opening balance row
    if (/balance\s*b\/?f/i.test(desc)) {
      const balStr = colBalance !== -1 ? String(row[colBalance] || "") : "";
      const bal = parseBalStr(balStr);
      meta.openingBalance = bal.amount;
      openingBalance = bal;
      continue;
    }

    const debit = colDebit !== -1 ? parseAmt(row[colDebit]) : 0;
    const credit = colCredit !== -1 ? parseAmt(row[colCredit]) : 0;
    if (debit === 0 && credit === 0) continue;

    const balStr =
      colBalance !== -1 ? String(row[colBalance] || "").trim() : "";
    const bal = parseBalStr(balStr);
    const vDate = colValueDate !== -1 ? parseDate(row[colValueDate]) : null;
    const pDate = colPostDate !== -1 ? parseDate(row[colPostDate]) : null;

    transactions.push({
      valueDate: vDate || pDate,
      postDate: pDate || vDate,
      description: desc.substring(0, 500),
      chequeNo: colCheque !== -1 ? String(row[colCheque] || "").trim() : "",
      debit,
      credit,
      balance: bal.amount,
      balanceSuffix: bal.suffix,
      branch:
        colBranch !== -1
          ? String(row[colBranch] || "")
              .trim()
              .substring(0, 100)
          : "",
    });
  }

  if (transactions.length === 0) {
    throw new Error(
      "No transactions found in the file. Please check the statement format.",
    );
  }

  return {
    ...meta,
    openingBalance: meta.openingBalance,
    transactions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-matching: bank txn ↔ ledger voucher entry
// Bank CREDIT → Dr on bank ledger (asset increases)
// Bank DEBIT  → Cr on bank ledger (asset decreases)
// ─────────────────────────────────────────────────────────────────────────────
async function autoMatch(companyId, bankLedgerId, transactions) {
  if (!bankLedgerId || !transactions.length) return transactions;

  const ledId = new mongoose.Types.ObjectId(bankLedgerId);
  const dates = transactions
    .map((t) => t.valueDate || t.postDate)
    .filter(Boolean);
  if (!dates.length) return transactions;

  const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  minDate.setDate(minDate.getDate() - 5);
  maxDate.setDate(maxDate.getDate() + 5);

  // Get all posted vouchers touching the bank ledger in this date range
  const vouchers = await Acc_Voucher.find({
    companyId: new mongoose.Types.ObjectId(companyId),
    status: "posted",
    voucherDate: { $gte: minDate, $lte: maxDate },
    "ledgerEntries.ledgerId": ledId,
  })
    .select("_id voucherNumber voucherType voucherDate ledgerEntries narration")
    .lean();

  // Flatten into per-entry list
  const ledgerLines = [];
  for (const v of vouchers) {
    for (const e of v.ledgerEntries || []) {
      if (String(e.ledgerId) !== String(ledId)) continue;
      ledgerLines.push({
        voucherId: v._id,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        date: v.voucherDate,
        type: e.type, // "Dr" or "Cr"
        amount: e.amount || 0,
        narration: v.narration,
      });
    }
  }

  // Match: tolerance ±3 days, exact amount
  const usedLines = new Set();

  return transactions.map((txn) => {
    if (txn.matched) return txn;
    const isCreditTxn = txn.credit > 0;
    const amount = isCreditTxn ? txn.credit : txn.debit;
    const expectedType = isCreditTxn ? "Dr" : "Cr"; // bank CR → ledger Dr (asset +)
    const txnDate = txn.valueDate || txn.postDate;
    if (!txnDate) return txn;

    const match = ledgerLines.findIndex((l, idx) => {
      if (usedLines.has(idx)) return false;
      if (l.type !== expectedType) return false;
      if (Math.abs(l.amount - amount) > 0.01) return false;
      const daysDiff =
        Math.abs(new Date(l.date).getTime() - txnDate.getTime()) /
        (1000 * 86400);
      return daysDiff <= 3;
    });

    if (match === -1) return txn;
    usedLines.add(match);
    const m = ledgerLines[match];
    return {
      ...txn,
      matched: true,
      matchedVoucherId: m.voucherId,
      matchedVoucherNumber: m.voucherNumber,
      matchedVoucherType: m.voucherType,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build ledger-side comparison data for a session
// ─────────────────────────────────────────────────────────────────────────────
async function buildLedgerSide(session) {
  if (!session.bankLedgerId || !session.periodFrom || !session.periodTo) {
    return { entries: [], totalDr: 0, totalCr: 0 };
  }

  const ledId = new mongoose.Types.ObjectId(session.bankLedgerId);
  const vouchers = await Acc_Voucher.find({
    companyId: session.companyId,
    status: "posted",
    voucherDate: {
      $gte: new Date(
        `${session.periodFrom.toISOString().slice(0, 10)}T00:00:00.000+05:30`,
      ),
      $lte: new Date(
        `${session.periodTo.toISOString().slice(0, 10)}T23:59:59.999+05:30`,
      ),
    },
    "ledgerEntries.ledgerId": ledId,
  })
    .select(
      "_id voucherNumber voucherType voucherDate ledgerEntries narration partyLedgerName grandTotal",
    )
    .sort({ voucherDate: 1 })
    .lean();

  const matchedVoucherIds = new Set(
    session.transactions
      .filter((t) => t.matched && t.matchedVoucherId)
      .map((t) => String(t.matchedVoucherId)),
  );

  const entries = [];
  for (const v of vouchers) {
    for (const e of v.ledgerEntries || []) {
      if (String(e.ledgerId) !== String(ledId)) continue;
      entries.push({
        voucherId: v._id,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        date: v.voucherDate,
        description: v.partyLedgerName || v.narration || v.voucherNumber,
        type: e.type,
        amount: e.amount || 0,
        matched: matchedVoucherIds.has(String(v._id)),
      });
    }
  }

  const totalDr = entries
    .filter((e) => e.type === "Dr")
    .reduce((s, e) => s + e.amount, 0);
  const totalCr = entries
    .filter((e) => e.type === "Cr")
    .reduce((s, e) => s + e.amount, 0);

  return { entries, totalDr, totalCr };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });

    const { companyId, bankLedgerId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    // Parse the statement
    let parsed;
    try {
      parsed = parseBankStatement(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    // Resolve bank ledger name
    let ledgerName = "";
    if (bankLedgerId) {
      const led = await Acc_Ledger.findById(bankLedgerId).select("name").lean();
      ledgerName = led?.name || "";
    }

    // Auto-match
    const matchedTxns = await autoMatch(
      companyId,
      bankLedgerId,
      parsed.transactions,
    );

    // Summaries
    const totalCredits = matchedTxns.reduce((s, t) => s + t.credit, 0);
    const totalDebits = matchedTxns.reduce((s, t) => s + t.debit, 0);
    const matchedCount = matchedTxns.filter((t) => t.matched).length;
    const unmatchedCount = matchedTxns.length - matchedCount;

    const session = await Acc_BankReconSession.create({
      companyId,
      bankLedgerId: bankLedgerId || undefined,
      bankLedgerName: ledgerName,
      accountNumber: parsed.accountNumber,
      bankName: parsed.bankName,
      ifscCode: parsed.ifscCode,
      branch: parsed.branch,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
      openingBalance: parsed.openingBalance,
      closingBalance: parsed.closingBalance,
      totalCredits,
      totalDebits,
      txnCount: matchedTxns.length,
      matchedCount,
      unmatchedCount,
      filename: req.file.originalname,
      filesize: req.file.size,
      transactions: matchedTxns,
    });

    res.json({
      success: true,
      sessionId: session._id,
      summary: {
        txnCount: session.txnCount,
        totalCredits,
        totalDebits,
        matchedCount,
        unmatchedCount,
      },
    });
  } catch (e) {
    console.error("[bank-recon/upload]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sessions — list sessions for a company
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const sessions = await Acc_BankReconSession.find({ companyId })
      .select("-transactions")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({ success: true, sessions });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sessions/:id — full session with ledger comparison
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sessions/:id", async (req, res) => {
  try {
    const session = await Acc_BankReconSession.findById(req.params.id).lean();
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const ledgerSide = await buildLedgerSide(session);

    res.json({ success: true, session, ledger: ledgerSide });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /sessions/:id/match — manually match a bank txn to a voucher
// Body: { txnId, voucherId }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/sessions/:id/match", async (req, res) => {
  try {
    const { txnId, voucherId } = req.body;
    const session = await Acc_BankReconSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const txn = session.transactions.id(txnId);
    if (!txn)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });

    const voucher = await Acc_Voucher.findById(voucherId)
      .select("voucherNumber voucherType")
      .lean();
    if (!voucher)
      return res
        .status(404)
        .json({ success: false, message: "Voucher not found" });

    txn.matched = true;
    txn.matchedVoucherId = voucher._id;
    txn.matchedVoucherNumber = voucher.voucherNumber;
    txn.matchedVoucherType = voucher.voucherType;

    // Recompute counts
    session.matchedCount = session.transactions.filter((t) => t.matched).length;
    session.unmatchedCount = session.transactions.length - session.matchedCount;

    await session.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /sessions/:id/unmatch
// Body: { txnId }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/sessions/:id/unmatch", async (req, res) => {
  try {
    const { txnId } = req.body;
    const session = await Acc_BankReconSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const txn = session.transactions.id(txnId);
    if (!txn)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });

    txn.matched = false;
    txn.matchedVoucherId = undefined;
    txn.matchedVoucherNumber = undefined;
    txn.matchedVoucherType = undefined;

    session.matchedCount = session.transactions.filter((t) => t.matched).length;
    session.unmatchedCount = session.transactions.length - session.matchedCount;

    await session.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /sessions/:id/reconcile — mark a transaction as fully reconciled
// Body: { txnId, reconciled: boolean, note?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/sessions/:id/reconcile", async (req, res) => {
  try {
    const { txnId, reconciled, note } = req.body;
    const session = await Acc_BankReconSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const txn = session.transactions.id(txnId);
    if (!txn)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });

    txn.reconciled = !!reconciled;
    if (note !== undefined) txn.note = note;

    const allReconciled = session.transactions.every((t) => t.reconciled);
    session.status = allReconciled ? "reconciled" : "in_progress";

    await session.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /sessions/:id/ledger — update which bank ledger this session uses
// Body: { bankLedgerId }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/sessions/:id/ledger", async (req, res) => {
  try {
    const { bankLedgerId } = req.body;
    const session = await Acc_BankReconSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const led = await Acc_Ledger.findById(bankLedgerId).select("name").lean();
    if (!led)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found" });

    session.bankLedgerId = bankLedgerId;
    session.bankLedgerName = led.name;

    // Re-run auto-match
    const rematched = await autoMatch(
      String(session.companyId),
      bankLedgerId,
      session.transactions.map((t) => t.toObject()),
    );
    session.transactions = rematched;
    session.matchedCount = rematched.filter((t) => t.matched).length;
    session.unmatchedCount = rematched.length - session.matchedCount;

    await session.save();
    res.json({ success: true, matchedCount: session.matchedCount });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /sessions/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/sessions/:id", async (req, res) => {
  try {
    await Acc_BankReconSession.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /bank-ledgers — list bank & cash ledgers for a company
// ─────────────────────────────────────────────────────────────────────────────
router.get("/bank-ledgers", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    // Find groups: Bank Accounts, Cash-in-Hand
    const bankGroups = await Acc_Group.find({
      companyId,
      isActive: true,
      name: { $in: ["Bank Accounts", "Cash-in-Hand", "Bank OD A/c"] },
    })
      .select("_id")
      .lean();

    const groupIds = bankGroups.map((g) => g._id);
    const ledgers = await Acc_Ledger.find({
      companyId,
      isActive: true,
      groupId: { $in: groupIds },
    })
      .select("_id name groupName currentBalance balanceType")
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, ledgers });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
