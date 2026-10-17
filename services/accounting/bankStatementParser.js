"use strict";

/**
 * Reads a bank statement (.xls / .xlsx / .csv) into transactions for the BRS.
 * Moved out of routes/Accountant_Routes/Acc_bankRecon.js (13 Oct 2026) so it
 * can be tested on real statements.
 *
 * ── TWO SHAPES ──────────────────────────────────────────────────────────────
 * Indian Bank (and SBI, ICICI…): a Debit column and a Credit column,
 *   "Transaction Date" / "Value Date", a closing balance with CR/DR.
 * HDFC Bank (the "Accountstmt_<account>_<stamp>.XLS" export):
 *   a key/value block above the table — "Account Number | 5020…",
 *   "Opening Balance | 30000.00", "Closing Balance", "From Date", "To Date" —
 *   one cell for the label and the next for the value, no colon; then
 *   Transaction Date (with a time: "19/09/2026 16:12:38") · Transaction
 *   Description · Transaction Amount · Debit / Credit ("D" / "C") ·
 *   Reference No. · Value Date · Transaction Branch · Running Balance;
 *   newest first.
 * Before this, HDFC read as nothing: the "Debit / Credit" header matched BOTH
 * the debit and the credit column patterns, so each line's amount was read
 * from the "D"/"C" cell, came out 0 and was skipped — and the account number
 * and balances in the key/value block were never seen.
 */

/* Required on first use: loading xlsx at the top made every server start pay for it. */
const xlsx = () => require("xlsx");

function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // DD-MM-YYYY or DD/MM/YYYY, optionally followed by a time (HDFC).
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (m)
    return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00.000+05:30`);
  // DD-MM-YY / DD/MM/YY
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})\b(?![-/\d])/);
  if (m)
    return new Date(`20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00.000+05:30`);
  // YYYY-MM-DD
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (m)
    return new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00.000+05:30`);
  // Excel serial
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = xlsx().SSF.parse_date_code(parseFloat(s));
    if (d)
      return new Date(`${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}T00:00:00.000+05:30`);
  }
  return null;
}

function parseAmt(v) {
  return parseFloat(String(v || "").replace(/,/g, "").trim()) || 0;
}

function parseBalStr(s) {
  const m = String(s || "").match(/(-?[\d,]+\.?\d*)\s*(CR|DR)?/i);
  if (!m) return { amount: 0, suffix: "CR" };
  const amount = parseFloat(m[1].replace(/,/g, "")) || 0;
  return {
    amount: Math.abs(amount),
    suffix: (m[2] || (amount < 0 ? "DR" : "CR")).toUpperCase(),
  };
}

/** "D", "Dr", "Debit", "W" → debit; "C", "Cr", "Credit", "D/P" … → credit. */
function directionOf(v) {
  const s = String(v || "").trim().toLowerCase();
  if (/^(d|dr|debit|w|withdrawal)\.?$/.test(s)) return "debit";
  if (/^(c|cr|credit|dep|deposit)\.?$/.test(s)) return "credit";
  return null;
}

function parseBankStatement(buffer) {
  const wb = xlsx().read(buffer, { type: "buffer", cellDates: false, cellText: true, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx().utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });

  const meta = {
    bankName: "",
    format: "generic",
    accountNumber: "",
    accountHolder: "",
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

    const hasDateCol = cells.some(
      (c) => /(value|txn|transaction|post(ing)?)\s*date/i.test(c) || /^date$/i.test(c),
    );
    const hasAmountCol = cells.some(
      (c) => /(debit|credit|withdrawal|deposit)/i.test(c) || /\bamount\b/i.test(c),
    );
    if (hasDateCol && hasAmountCol) {
      headerRowIdx = i;
      break;
    }

    /* Key | value in two cells (HDFC), read before the free-text rules. */
    const filled = cells.filter(Boolean);
    if (filled.length === 2) {
      const [k, v] = filled;
      const key = k.toLowerCase().replace(/[:.]+$/, "").trim();
      if (/^account\s*(number|no)$/.test(key) && /^\d{6,20}$/.test(v.replace(/\s/g, ""))) meta.accountNumber = v.replace(/\s/g, "");
      else if (/^(customer|account)\s*name$/.test(key)) meta.accountHolder = v;
      else if (/^opening\s*balance$/.test(key)) meta.openingBalance = parseBalStr(v).amount;
      else if (/^(closing|available|cleared)\s*balance$/.test(key)) meta.closingBalance = parseBalStr(v).amount;
      else if (/^(from|start)\s*date$/.test(key)) meta.periodFrom = parseDate(v);
      else if (/^(to|end)\s*date$/.test(key)) meta.periodTo = parseDate(v);
      else if (/^ifsc/.test(key) && /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v)) meta.ifscCode = v.toUpperCase();
      else if (/^branch/.test(key)) meta.branch = v.substring(0, 60);
    }

    if (!meta.bankName && /BANK|FINANCIAL|COOPERATIVE/i.test(line) && line.length < 60) meta.bankName = line;
    const acctM = line.match(/account\s*(?:number|no)?\s*[:.]\s*(\d{6,20})/i);
    if (acctM) meta.accountNumber = acctM[1];
    const ifscM = line.match(/IFSC\s*(?:CODE)?\s*[:.]\s*([A-Z]{4}0[A-Z0-9]{6})/i);
    if (ifscM) meta.ifscCode = ifscM[1];
    const branchM = line.match(/Branch\s*[:.]\s*(.+)/i);
    if (branchM && !meta.branch) meta.branch = branchM[1].trim().substring(0, 60);
    const clearM = line.match(/cleared\s+balance\s*[:.]\s*([\d,]+\.?\d*)/i);
    if (clearM) meta.closingBalance = parseFloat(clearM[1].replace(/,/g, ""));
  }

  if (headerRowIdx === -1)
    throw new Error(
      "Could not find the transaction header row. Expected a row with a date column " +
        "(Transaction/Value/Posting Date) and a Debit/Credit (or Withdrawal/Deposit/Amount) column.",
    );

  const headers = rows[headerRowIdx].map((c) => String(c || "").trim().toLowerCase());
  const taken = new Set();
  const col = (ps) => {
    for (const p of ps) {
      const i = headers.findIndex((h, idx) => !taken.has(idx) && p.test(h));
      if (i !== -1) return i;
    }
    return -1;
  };
  const claim = (i) => {
    if (i !== -1) taken.add(i);
    return i;
  };

  /* The direction column first ("Debit / Credit", "Dr/Cr", "Type"), so the
     debit and credit patterns below can never land on it. */
  const colDirection = claim(col([/debit\s*\/\s*credit/, /^(dr|cr)\s*\/\s*(cr|dr)$/, /^d\s*\/\s*c$/, /^cr\/dr$/, /^txn\s*type$/]));
  const colAmount = colDirection !== -1 ? claim(col([/transaction\s*amount/, /txn\s*amount/, /^amount/])) : -1;

  const colValueDate = claim(col([/value\s*date/, /txn\s*date/, /^date$/]));
  const colPostDate = claim(col([/post\s*date/, /transaction\s*date/]));
  const colDesc = claim(col([/description/, /narration/, /particulars/, /remarks/]));
  const colCheque = claim(col([/cheque/, /chq/, /ref(erence)?\.?\s*no/, /utr/]));
  const colDebit = colDirection !== -1 ? -1 : claim(col([/debit\s*amount/, /withdrawal/, /\bdebit\b/, /^dr$/]));
  const colCredit = colDirection !== -1 ? -1 : claim(col([/credit\s*amount/, /deposit/, /\bcredit\b/, /^cr$/]));
  const colBalance = claim(col([/closing\s*balance/, /running\s*balance/, /^balance$/, /balance/]));
  const colBranch = claim(col([/remitter\s*branch/, /transaction\s*branch/, /branch/, /remitter/]));
  const colAcct = claim(col([/account\s*(number|no)/, /^a\/c/, /account/]));

  if (colDesc === -1) throw new Error("Could not identify Description column.");
  if (colDirection !== -1 && colAmount === -1)
    throw new Error("The statement has a Debit / Credit column but no amount column next to it.");
  if (colDirection === -1 && colDebit === -1 && colCredit === -1)
    throw new Error("Could not identify the Debit/Credit (or Withdrawal/Deposit) columns.");

  /* Which bank, from the format itself — the HDFC export never prints its
     own name. */
  if (colDirection !== -1 && headers.some((h) => /transaction\s*branch/.test(h)) && headers.some((h) => /running\s*balance/.test(h))) {
    meta.format = "hdfc";
    if (!meta.bankName) meta.bankName = "HDFC Bank";
  } else if (/indian\s*bank/i.test(meta.bankName)) {
    meta.format = "indian_bank";
  }

  const transactions = [];
  let unreadDirection = 0;
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !String(c).trim())) continue;
    const desc = String(row[colDesc] || "").trim();
    if (!desc) continue;
    if (/^(total|end\s*of|statement\s*downloaded|unless|immediately|\*|#)/i.test(desc)) continue;
    if (/balance\s*b\/?f/i.test(desc)) {
      meta.openingBalance = parseBalStr(colBalance !== -1 ? String(row[colBalance] || "") : "").amount;
      continue;
    }
    let debit = 0;
    let credit = 0;
    if (colDirection !== -1) {
      const amount = parseAmt(row[colAmount]);
      const dir = directionOf(row[colDirection]);
      if (!dir) {
        if (amount) unreadDirection += 1;
        continue;
      }
      if (dir === "debit") debit = amount;
      else credit = amount;
    } else {
      debit = colDebit !== -1 ? parseAmt(row[colDebit]) : 0;
      credit = colCredit !== -1 ? parseAmt(row[colCredit]) : 0;
    }
    if (debit === 0 && credit === 0) continue;
    const bal = parseBalStr(colBalance !== -1 ? String(row[colBalance] || "").trim() : "");
    const vDate = colValueDate !== -1 ? parseDate(row[colValueDate]) : null;
    const pDate = colPostDate !== -1 ? parseDate(row[colPostDate]) : null;
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
      branch: colBranch !== -1 ? String(row[colBranch] || "").trim().substring(0, 100) : "",
    });
  }
  if (unreadDirection)
    throw new Error(`${unreadDirection} line(s) carry an amount but no readable Debit / Credit mark — nothing was imported.`);
  if (!transactions.length) throw new Error("No transactions found in the file.");
  return { ...meta, transactions };
}

module.exports = { parseBankStatement, parseDate, parseAmt, parseBalStr, directionOf };
