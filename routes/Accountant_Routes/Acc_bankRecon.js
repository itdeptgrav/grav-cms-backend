// routes/Accountant_Routes/Acc_bankRecon.js
// =============================================================================
// BANK RECONCILIATION — v2
// Upload a bank statement month-by-month, compare vs ledger, manual-match.
//
// ENDPOINTS (mounted at /api/accountant/bank-recon):
//   POST   /upload                      → upload + parse + filter to period + auto-match
//   GET    /sessions                    → list sessions for a company
//   GET    /sessions/:id                → full session with ledger comparison
//   PUT    /sessions/:id/match          → manually match a bank txn to a voucher
//   PUT    /sessions/:id/unmatch        → clear a match
//   PUT    /sessions/:id/reconcile      → mark txn reconciled/unreconciled
//   PUT    /sessions/:id/ledger         → update bank ledger + re-run auto-match
//   DELETE /sessions/:id                → delete session
//   GET    /sessions/:id/match-candidates → vouchers eligible for manual match
//   GET    /bank-ledgers                → bank/cash ledgers for a company
//   GET    /annual-summary             → aggregate all sessions for a year
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

// ─── Multer ──────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only .xlsx, .xls, .csv files accepted"), ok);
  },
});

// ─── Schema ──────────────────────────────────────────────────────────────────
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
    matched: { type: Boolean, default: false },
    matchedVoucherId: mongoose.Types.ObjectId,
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
    accountNumber: String,
    bankName: String,
    ifscCode: String,
    branch: String,
    // IST period boundaries (explicit from user selection)
    periodMonth: { type: Number, min: 1, max: 12 }, // 1-12
    periodYear: Number,
    periodLabel: String, // e.g. "May 2026"
    periodFrom: Date, // IST start of month
    periodTo: Date, // IST end of month
    openingBalance: Number,
    closingBalance: Number,
    totalCredits: { type: Number, default: 0 },
    totalDebits: { type: Number, default: 0 },
    txnCount: { type: Number, default: 0 },
    matchedCount: { type: Number, default: 0 },
    unmatchedCount: { type: Number, default: 0 },
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

// ─── IST helpers ─────────────────────────────────────────────────────────────
function istStartOfMonth(year, month) {
  // month: 1-12
  const mm = String(month).padStart(2, "0");
  return new Date(`${year}-${mm}-01T00:00:00.000+05:30`);
}

function istEndOfMonth(year, month) {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const dd = String(lastDay).padStart(2, "0");
  return new Date(`${year}-${mm}-${dd}T23:59:59.999+05:30`);
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // DD-MM-YYYY or DD/MM/YYYY (Indian bank format — dashes OR slashes).
  // Indian Bank exports use dashes (e.g. 23-07-2025); the old code only
  // accepted slashes, so every date came back null and the whole month
  // got filtered out.
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (m) {
    return new Date(
      `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00.000+05:30`,
    );
  }
  // YYYY-MM-DD or YYYY/MM/DD (ISO)
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (m) {
    return new Date(
      `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00.000+05:30`,
    );
  }
  // Excel serial date number
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
  return (
    parseFloat(
      String(v || "")
        .replace(/,/g, "")
        .trim(),
    ) || 0
  );
}

function parseBalStr(s) {
  const m = String(s || "").match(/([\d,]+\.?\d*)\s*(CR|DR)?/i);
  if (!m) return { amount: 0, suffix: "CR" };
  return {
    amount: parseFloat(m[1].replace(/,/g, "")) || 0,
    suffix: (m[2] || "CR").toUpperCase(),
  };
}

// Stable identity for a single statement line — used to carry over manual
// matches / reconciled flags when the SAME month is re-uploaded, so prior
// reconciliation work is never wiped.
function txnKey(t) {
  const d = t.valueDate || t.postDate;
  const ds = d ? new Date(d).toISOString().slice(0, 10) : "";
  return [
    ds,
    Number(t.debit || 0).toFixed(2),
    Number(t.credit || 0).toFixed(2),
    Number(t.balance || 0).toFixed(2),
    String(t.description || "")
      .slice(0, 60)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
  ].join("|");
}

// ─── Statement parser ─────────────────────────────────────────────────────────
function parseBankStatement(buffer, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    cellText: true,
    raw: true,
  });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: false,
  });

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
    const cells = rows[i].map((c) => String(c || "").trim());
    const line = cells.join(" ").trim();
    if (!line) continue;

    // A header row has BOTH a date-like column AND a debit/credit/amount
    // column. This catches "Transaction Date" + "Credit Amount" / "Debit
    // Amount" (Indian Bank), "Value Date" + "Withdrawal"/"Deposit" (HDFC/
    // ICICI), "Date" + "Debit"/"Credit" (SBI), etc. The old check only
    // recognised "value date" or an exact "date" cell, so Indian Bank's
    // "Transaction Date" header was never found.
    const hasDateCol = cells.some(
      (c) =>
        /(value|txn|transaction|post(ing)?)\s*date/i.test(c) ||
        /^date$/i.test(c),
    );
    const hasAmountCol = cells.some(
      (c) =>
        /(debit|credit|withdrawal|deposit)/i.test(c) || /\bamount\b/i.test(c),
    );
    if (hasDateCol && hasAmountCol) {
      headerRowIdx = i;
      break;
    }
    if (
      !meta.bankName &&
      /BANK|FINANCIAL|COOPERATIVE/i.test(line) &&
      line.length < 60
    )
      meta.bankName = line;
    const acctM = line.match(/account\s*(?:number|no)?\s*[:.]\s*(\d{6,20})/i);
    if (acctM) meta.accountNumber = acctM[1];
    const ifscM = line.match(
      /IFSC\s*(?:CODE)?\s*[:.]\s*([A-Z]{4}0[A-Z0-9]{6})/i,
    );
    if (ifscM) meta.ifscCode = ifscM[1];
    const branchM = line.match(/Branch\s*[:.]\s*(.+)/i);
    if (branchM && !meta.branch)
      meta.branch = branchM[1].trim().substring(0, 60);
    const clearM = line.match(/cleared\s+balance\s*[:.]\s*([\d,]+\.?\d*)/i);
    if (clearM) meta.closingBalance = parseFloat(clearM[1].replace(/,/g, ""));
  }

  if (headerRowIdx === -1)
    throw new Error(
      "Could not find the transaction header row. Expected a row with a " +
        "date column (Transaction/Value/Posting Date) and a Debit/Credit " +
        "(or Withdrawal/Deposit/Amount) column.",
    );

  const headers = rows[headerRowIdx].map((c) =>
    String(c || "")
      .trim()
      .toLowerCase(),
  );
  const col = (ps) => {
    for (const p of ps) {
      const i = headers.findIndex((h) => p.test(h));
      if (i !== -1) return i;
    }
    return -1;
  };

  const colValueDate = col([/value\s*date/, /txn\s*date/, /^date$/]);
  const colPostDate = col([/post\s*date/, /transaction\s*date/]);
  const colDesc = col([/description/, /narration/, /particulars/, /remarks/]);
  const colCheque = col([/cheque/, /chq/, /ref\s*no/]);
  const colDebit = col([/debit\s*amount/, /withdrawal/, /\bdebit\b/, /^dr$/]);
  const colCredit = col([/credit\s*amount/, /deposit/, /\bcredit\b/, /^cr$/]);
  // "Closing Balance" / "Balance" — but NOT the credit/debit amount columns.
  const colBalance = col([
    /closing\s*balance/,
    /running\s*balance/,
    /^balance$/,
    /balance/,
  ]);
  const colBranch = col([/remitter\s*branch/, /branch/, /remitter/]);
  const colAcct = col([/account\s*(number|no)/, /^a\/c/, /account/]);

  if (colDesc === -1) throw new Error("Could not identify Description column.");
  if (colDebit === -1 && colCredit === -1)
    throw new Error(
      "Could not identify the Debit/Credit (or Withdrawal/Deposit) columns.",
    );

  const transactions = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !String(c).trim())) continue;
    const desc = colDesc !== -1 ? String(row[colDesc] || "").trim() : "";
    if (!desc) continue;
    if (
      /^(total|end\s*of|statement\s*downloaded|unless|immediately|\*|#)/i.test(
        desc,
      )
    )
      continue;
    if (/balance\s*b\/?f/i.test(desc)) {
      const bal = parseBalStr(
        colBalance !== -1 ? String(row[colBalance] || "") : "",
      );
      meta.openingBalance = bal.amount;
      continue;
    }
    const debit = colDebit !== -1 ? parseAmt(row[colDebit]) : 0;
    const credit = colCredit !== -1 ? parseAmt(row[colCredit]) : 0;
    if (debit === 0 && credit === 0) continue;
    const bal = parseBalStr(
      colBalance !== -1 ? String(row[colBalance] || "").trim() : "",
    );
    const vDate = colValueDate !== -1 ? parseDate(row[colValueDate]) : null;
    const pDate = colPostDate !== -1 ? parseDate(row[colPostDate]) : null;
    // Grab the account number from the first data row if the header block
    // didn't carry one (Indian Bank puts it in a per-row column).
    if (!meta.accountNumber && colAcct !== -1) {
      const acct = String(row[colAcct] || "").trim();
      if (/^\d{6,20}$/.test(acct)) meta.accountNumber = acct;
    }
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
  if (!transactions.length)
    throw new Error("No transactions found in the file.");
  return { ...meta, transactions };
}

// ─── Auto-match ───────────────────────────────────────────────────────────────
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

  const vouchers = await Acc_Voucher.find({
    companyId: new mongoose.Types.ObjectId(companyId),
    status: "posted",
    voucherDate: { $gte: minDate, $lte: maxDate },
    "ledgerEntries.ledgerId": ledId,
  })
    .select("_id voucherNumber voucherType voucherDate ledgerEntries narration")
    .lean();

  const ledgerLines = [];
  for (const v of vouchers) {
    for (const e of v.ledgerEntries || []) {
      if (String(e.ledgerId) !== String(ledId)) continue;
      ledgerLines.push({
        voucherId: v._id,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        date: v.voucherDate,
        type: e.type,
        amount: e.amount || 0,
      });
    }
  }

  const usedLines = new Set();
  return transactions.map((txn) => {
    if (txn.matched) return txn;
    const isCreditTxn = txn.credit > 0;
    const amount = isCreditTxn ? txn.credit : txn.debit;
    const expectedType = isCreditTxn ? "Dr" : "Cr";
    const txnDate = txn.valueDate || txn.postDate;
    if (!txnDate) return txn;
    const matchIdx = ledgerLines.findIndex((l, idx) => {
      if (usedLines.has(idx)) return false;
      if (l.type !== expectedType) return false;
      if (Math.abs(l.amount - amount) > 0.01) return false;
      return (
        Math.abs(new Date(l.date).getTime() - txnDate.getTime()) /
          (1000 * 86400) <=
        3
      );
    });
    if (matchIdx === -1) return txn;
    usedLines.add(matchIdx);
    const m = ledgerLines[matchIdx];
    return {
      ...txn,
      matched: true,
      matchedVoucherId: m.voucherId,
      matchedVoucherNumber: m.voucherNumber,
      matchedVoucherType: m.voucherType,
    };
  });
}

// ─── Ledger side builder ──────────────────────────────────────────────────────
async function buildLedgerSide(session) {
  if (!session.bankLedgerId || !session.periodFrom || !session.periodTo)
    return { entries: [], totalDr: 0, totalCr: 0 };
  const ledId = new mongoose.Types.ObjectId(session.bankLedgerId);
  const vouchers = await Acc_Voucher.find({
    companyId: session.companyId,
    status: "posted",
    voucherDate: { $gte: session.periodFrom, $lte: session.periodTo },
    "ledgerEntries.ledgerId": ledId,
  })
    .select(
      "_id voucherNumber voucherType voucherDate ledgerEntries narration partyLedgerName",
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

// ═════════════════════════════════════════════════════════════════════════════
// POST /upload
// ═════════════════════════════════════════════════════════════════════════════
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    const { companyId, bankLedgerId, periodMonth, periodYear } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const month = parseInt(periodMonth, 10);
    const year = parseInt(periodYear, 10);
    if (!month || !year || month < 1 || month > 12)
      return res.status(400).json({
        success: false,
        message: "periodMonth (1-12) and periodYear are required",
      });

    let parsed;
    try {
      parsed = parseBankStatement(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    // Filter transactions to the selected IST period
    const periodStart = istStartOfMonth(year, month);
    const periodEnd = istEndOfMonth(year, month);
    const periodTxns = parsed.transactions.filter((t) => {
      const d = t.valueDate || t.postDate;
      return d && d >= periodStart && d <= periodEnd;
    });

    if (periodTxns.length === 0)
      return res.status(400).json({
        success: false,
        message: `No transactions found for ${MONTH_NAMES[month - 1]} ${year} in the uploaded file. The file has ${parsed.transactions.length} total transactions — check that the correct month is selected.`,
      });

    const ledgerName = bankLedgerId
      ? (await Acc_Ledger.findById(bankLedgerId).select("name").lean())?.name ||
        ""
      : "";
    let matchedTxns = await autoMatch(companyId, bankLedgerId, periodTxns);

    // ── Preserve prior reconciliation work ────────────────────────────────
    // If a session already exists for this exact bank ledger + month + year,
    // carry over its manual matches / reconciled ticks / notes by line key,
    // and UPDATE that session in place instead of creating a duplicate. So
    // re-uploading the same statement never makes you redo work — only new
    // lines come in unmatched; everything already reconciled stays as-is.
    const existing = await Acc_BankReconSession.findOne({
      companyId,
      periodMonth: month,
      periodYear: year,
      ...(bankLedgerId ? { bankLedgerId } : {}),
    });
    if (existing && existing.transactions && existing.transactions.length) {
      const prior = new Map();
      for (const t of existing.transactions) prior.set(txnKey(t), t);
      matchedTxns = matchedTxns.map((t) => {
        const p = prior.get(txnKey(t));
        if (!p) return t;
        const carried = { ...t };
        // A match already on record for this exact line wins over auto-match.
        if (p.matched && p.matchedVoucherId) {
          carried.matched = true;
          carried.matchedVoucherId = p.matchedVoucherId;
          carried.matchedVoucherNumber = p.matchedVoucherNumber;
          carried.matchedVoucherType = p.matchedVoucherType;
        }
        if (p.reconciled) carried.reconciled = true;
        if (p.note) carried.note = p.note;
        return carried;
      });
    }

    const totalCredits = matchedTxns.reduce((s, t) => s + t.credit, 0);
    const totalDebits = matchedTxns.reduce((s, t) => s + t.debit, 0);
    const matchedCount = matchedTxns.filter((t) => t.matched).length;
    const unmatchedCount = matchedTxns.length - matchedCount;
    const periodLabel = `${MONTH_NAMES[month - 1]} ${year}`;

    let session;
    if (existing) {
      // Update the existing month in place — keeps the same row in the
      // sidebar with all carried-over matches, no duplicate session.
      existing.bankLedgerId = bankLedgerId || existing.bankLedgerId;
      existing.bankLedgerName = ledgerName || existing.bankLedgerName;
      existing.accountNumber = parsed.accountNumber || existing.accountNumber;
      existing.bankName = parsed.bankName || existing.bankName;
      existing.ifscCode = parsed.ifscCode || existing.ifscCode;
      existing.branch = parsed.branch || existing.branch;
      existing.periodLabel = periodLabel;
      existing.periodFrom = periodStart;
      existing.periodTo = periodEnd;
      if (parsed.openingBalance != null)
        existing.openingBalance = parsed.openingBalance;
      if (parsed.closingBalance != null)
        existing.closingBalance = parsed.closingBalance;
      existing.totalCredits = totalCredits;
      existing.totalDebits = totalDebits;
      existing.txnCount = matchedTxns.length;
      existing.matchedCount = matchedCount;
      existing.unmatchedCount = unmatchedCount;
      existing.filename = req.file.originalname;
      existing.filesize = req.file.size;
      existing.transactions = matchedTxns;
      existing.status = matchedTxns.every((t) => t.reconciled)
        ? "reconciled"
        : matchedCount > 0
          ? "in_progress"
          : "pending";
      await existing.save();
      session = existing;
    } else {
      session = await Acc_BankReconSession.create({
        companyId,
        bankLedgerId: bankLedgerId || undefined,
        bankLedgerName: ledgerName,
        accountNumber: parsed.accountNumber,
        bankName: parsed.bankName,
        ifscCode: parsed.ifscCode,
        branch: parsed.branch,
        periodMonth: month,
        periodYear: year,
        periodLabel,
        periodFrom: periodStart,
        periodTo: periodEnd,
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
    }

    res.json({
      success: true,
      sessionId: session._id,
      merged: !!existing,
      summary: {
        txnCount: session.txnCount,
        totalCredits,
        totalDebits,
        matchedCount,
        unmatchedCount,
        periodLabel,
      },
    });
  } catch (e) {
    console.error("[bank-recon/upload]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /sessions
// ═════════════════════════════════════════════════════════════════════════════
router.get("/sessions", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    const skip = Math.max(0, parseInt(req.query.skip || "0", 10));
    const limit = 20;
    const [sessions, total] = await Promise.all([
      Acc_BankReconSession.find({ companyId })
        .select("-transactions")
        .sort({ periodYear: -1, periodMonth: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Acc_BankReconSession.countDocuments({ companyId }),
    ]);
    res.json({
      success: true,
      sessions,
      hasMore: skip + sessions.length < total,
      total,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /sessions/:id
// ═════════════════════════════════════════════════════════════════════════════
router.get("/sessions/:id", async (req, res) => {
  try {
    const session = await Acc_BankReconSession.findById(req.params.id).lean();
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    const ledger = await buildLedgerSide(session);
    res.json({ success: true, session, ledger });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /sessions/:id/match-candidates
// Returns vouchers involving the bank ledger near this transaction's date+amount
// Query: ?amount=X&txnDate=YYYY-MM-DD&type=credit|debit&q=search
// ═════════════════════════════════════════════════════════════════════════════
router.get("/sessions/:id/match-candidates", async (req, res) => {
  try {
    const session = await Acc_BankReconSession.findById(req.params.id)
      .select("companyId bankLedgerId periodFrom periodTo")
      .lean();
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (!session.bankLedgerId)
      return res.status(400).json({
        success: false,
        message: "No bank ledger linked to this session",
      });

    const { amount, txnDate, type, q } = req.query;
    const ledId = new mongoose.Types.ObjectId(session.bankLedgerId);

    // Date window: ±10 days from transaction date, capped at session period
    let dateFrom = session.periodFrom;
    let dateTo = session.periodTo;
    if (txnDate) {
      const base = new Date(`${txnDate}T00:00:00.000+05:30`);
      dateFrom = new Date(
        Math.max(
          base.getTime() - 10 * 86400000,
          (session.periodFrom || base).getTime(),
        ),
      );
      dateTo = new Date(
        Math.min(
          base.getTime() + 10 * 86400000,
          (session.periodTo || base).getTime(),
        ),
      );
    }

    const filter = {
      companyId: session.companyId,
      status: "posted",
      voucherDate: { $gte: dateFrom, $lte: dateTo },
      "ledgerEntries.ledgerId": ledId,
    };
    if (q) {
      filter.$or = [
        {
          voucherNumber: new RegExp(
            q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i",
          ),
        },
        {
          partyLedgerName: new RegExp(
            q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i",
          ),
        },
        {
          narration: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        },
      ];
    }

    const vouchers = await Acc_Voucher.find(filter)
      .select(
        "_id voucherNumber voucherType voucherDate partyLedgerName partyGstin partyLedgerId ledgerEntries narration",
      )
      .sort({ voucherDate: -1 })
      .limit(30)
      .lean();

    // Annotate each voucher with the bank-ledger entry amount
    const annotated = vouchers
      .map((v) => {
        const entry = v.ledgerEntries.find(
          (e) => String(e.ledgerId) === String(ledId),
        );
        const entryAmt = entry?.amount || 0;
        const entryType = entry?.type || "";
        const amtDiff = amount ? Math.abs(entryAmt - parseFloat(amount)) : null;
        return {
          ...v,
          bankEntryAmount: entryAmt,
          bankEntryType: entryType,
          amountDiff: amtDiff,
        };
      })
      .sort((a, b) => (a.amountDiff ?? 999999) - (b.amountDiff ?? 999999));

    res.json({ success: true, vouchers: annotated });
  } catch (e) {
    console.error("[match-candidates]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /sessions/:id/match
// ═════════════════════════════════════════════════════════════════════════════
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
    session.matchedCount = session.transactions.filter((t) => t.matched).length;
    session.unmatchedCount = session.transactions.length - session.matchedCount;
    await session.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /sessions/:id/unmatch
// ═════════════════════════════════════════════════════════════════════════════
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
    txn.matchedVoucherId =
      txn.matchedVoucherNumber =
      txn.matchedVoucherType =
        undefined;
    session.matchedCount = session.transactions.filter((t) => t.matched).length;
    session.unmatchedCount = session.transactions.length - session.matchedCount;
    await session.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /sessions/:id/reconcile
// ═════════════════════════════════════════════════════════════════════════════
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
    session.status = session.transactions.every((t) => t.reconciled)
      ? "reconciled"
      : "in_progress";
    await session.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /sessions/:id/ledger
// ═════════════════════════════════════════════════════════════════════════════
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

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /sessions/:id
// ═════════════════════════════════════════════════════════════════════════════
router.delete("/sessions/:id", async (req, res) => {
  try {
    await Acc_BankReconSession.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /bank-ledgers
// ═════════════════════════════════════════════════════════════════════════════
router.get("/bank-ledgers", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    const bankGroups = await Acc_Group.find({
      companyId,
      isActive: true,
      name: { $in: ["Bank Accounts", "Cash-in-Hand", "Bank OD A/c"] },
    })
      .select("_id")
      .lean();
    const ledgers = await Acc_Ledger.find({
      companyId,
      isActive: true,
      groupId: { $in: bankGroups.map((g) => g._id) },
    })
      .select("_id name groupName currentBalance balanceType")
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, ledgers });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /annual-summary
// Aggregates all sessions for a given bank ledger and year (FY or calendar)
// Query: ?companyId=...&bankLedgerId=...&year=2026&fyMode=true
// ═════════════════════════════════════════════════════════════════════════════
router.get("/annual-summary", async (req, res) => {
  try {
    const { companyId, bankLedgerId, year, fyMode } = req.query;
    if (!companyId || !year)
      return res
        .status(400)
        .json({ success: false, message: "companyId and year required" });

    const y = parseInt(year, 10);
    let sessions;
    if (fyMode === "true") {
      // Indian FY: Apr Y to Mar Y+1
      sessions = await Acc_BankReconSession.find({
        companyId,
        ...(bankLedgerId ? { bankLedgerId } : {}),
        $or: [
          { periodYear: y, periodMonth: { $gte: 4 } }, // Apr-Dec of year Y
          { periodYear: y + 1, periodMonth: { $lte: 3 } }, // Jan-Mar of year Y+1
        ],
      })
        .sort({ periodYear: 1, periodMonth: 1 })
        .lean();
    } else {
      sessions = await Acc_BankReconSession.find({
        companyId,
        ...(bankLedgerId ? { bankLedgerId } : {}),
        periodYear: y,
      })
        .sort({ periodMonth: 1 })
        .lean();
    }

    const summary = sessions.map((s) => ({
      _id: s._id,
      periodLabel: s.periodLabel,
      periodMonth: s.periodMonth,
      periodYear: s.periodYear,
      bankLedgerName: s.bankLedgerName,
      totalCredits: s.totalCredits,
      totalDebits: s.totalDebits,
      txnCount: s.txnCount,
      matchedCount: s.matchedCount,
      unmatchedCount: s.unmatchedCount,
      status: s.status,
    }));

    const totals = summary.reduce(
      (a, s) => ({
        totalCredits: a.totalCredits + s.totalCredits,
        totalDebits: a.totalDebits + s.totalDebits,
        txnCount: a.txnCount + s.txnCount,
        matchedCount: a.matchedCount + s.matchedCount,
        unmatchedCount: a.unmatchedCount + s.unmatchedCount,
      }),
      {
        totalCredits: 0,
        totalDebits: 0,
        txnCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
      },
    );

    res.json({
      success: true,
      sessions: summary,
      totals,
      year: y,
      fyMode: fyMode === "true",
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
