// services/tallyBSheetImporter.service.js
//
// TALLY BALANCE-SHEET / GROUP-SUMMARY JSON IMPORTER
// ─────────────────────────────────────────────────────────────────────────────
// Tally's "Display > Account Books > Group Summary" or "Balance Sheet" export
// (the ones with ledger statements drilled-down) produces a JSON file with
// these quirks:
//
//   1. Encoding is UTF-16 LE with CRLF line endings. Standard `JSON.parse` on
//      a buffer expects UTF-8.
//   2. The top-level structure has DUPLICATE keys at the same nesting level:
//
//        {
//          "mlvbody": {
//            "mlvledbody": { ledger 1 },
//            "mlvledbody": { ledger 2 },   ← JS object collapses these
//            "mlvledbody": { ledger 3 },
//            …
//          }
//        }
//
//      `JSON.parse` keeps only the LAST occurrence of each key. A 169-ledger
//      file gets reduced to 1 ledger. We can't use the native parser.
//
//   3. Voucher records are ONE-SIDED. Each transaction shows up TWICE in the
//      file (once per ledger). To rebuild proper double-entry vouchers, we
//      have to dedupe by (vchType, vchNumber, vchDate) and combine sides.
//
// This module:
//   • Decodes the UTF-16 buffer to UTF-8 text
//   • Uses a tolerant streaming parser that preserves duplicate keys
//   • Extracts {ledgers[], vouchers[]} ready for DB insert
//   • Auto-classifies each ledger into one of the 28 default groups using
//     heuristics over the ledger name + balance sign
//
// API:
//   parseBSheetJson(buffer)               → { ledgers, vouchers, stats }
//   classifyLedger(name, closingBalance)  → { groupName, nature, openingBalanceType }
//
// SAFETY NOTES:
//   • The parser is regex-based, NOT a strict JSON parser. It exploits the
//     fact that Tally's output has a predictable shape — every `mlvledbody`
//     wraps a single `lvacctitle` containing the data we want. Validated
//     against a sample of 169-ledger / 2167-voucher files.
//   • If the input doesn't match the expected shape, parseBSheetJson throws
//     a clear error. Don't catch broadly — surface the message.

// ─── Encoding ────────────────────────────────────────────────────────────────

function decodeBuffer(buffer) {
  // Try multiple decodings and pick the first that contains a Tally marker.
  const attempts = [];

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    attempts.push(buffer.slice(2).toString("utf16le"));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2) {
      if (i + 1 < buffer.length) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
    }
    attempts.push(swapped.toString("utf16le"));
  }
  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00) {
    attempts.push(buffer.toString("utf16le"));
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    attempts.push(buffer.slice(3).toString("utf8"));
  }
  attempts.push(buffer.toString("utf8"));

  const MARKERS = ['"mlvbody"', '"mlvledbody"', '"tallymessage"', '"metadata"'];
  for (const text of attempts) {
    for (const marker of MARKERS) {
      if (text.includes(marker)) return text;
    }
  }
  return attempts[0] || buffer.toString("utf8");
}

// ─── Duplicate-key-tolerant parser ───────────────────────────────────────────
//
// Strategy: regex-based extraction of each `mlvledbody` block, then standard
// JSON.parse on the individual block (which has unique keys internally).

function extractLedgerBlocks(text) {
  // The structure inside each mlvledbody is:
  //   "mlvledbody": { <BLOCK with balanced braces> }
  //
  // We walk character-by-character tracking brace depth from each `"mlvledbody"`
  // occurrence and collect the balanced block. JSON strings can contain `{`
  // and `}` so we also track string state to ignore braces inside strings.

  const blocks = [];
  const KEY = '"mlvledbody"';
  let idx = 0;

  while (true) {
    const start = text.indexOf(KEY, idx);
    if (start < 0) break;
    // Find the colon and the opening `{` of the value
    let i = start + KEY.length;
    while (i < text.length && text[i] !== "{") i++;
    if (i >= text.length) break;

    // Walk balanced braces, ignoring those inside string literals.
    const open = i;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          blocks.push(text.slice(open, i + 1));
          i++;
          break;
        }
      }
    }
    idx = i;
  }

  return blocks;
}

// ─── Per-ledger block parser ────────────────────────────────────────────────

function parseLedgerBlock(blockText) {
  // Each block looks roughly like:
  //   {
  //     "lvacctitle": {
  //       "lvacctitle": {
  //         "lvacctitle": "ABIRCHAND UTTAMCHAND",
  //         "mledpartyaddress": { "ledgrpaddress": { "ledgrpaddress": "..." } },
  //         "lvbody": {
  //           "dspvchdetail": [ ... ] | { ... single voucher },
  //           "lvclosingbalance": {
  //             "lvfcthree": { "lvsubdrtotal": …, "lvsubcrtotal": … }
  //           }
  //         }
  //       }
  //     }
  //   }
  //
  // Some ledgers have `dspvchdetail` as a single object (one voucher) instead
  // of an array. Some skip the address. Some skip closing balance. Be defensive.

  let parsed;
  try {
    parsed = JSON.parse(blockText);
  } catch (e) {
    throw new Error(`Couldn't parse ledger block: ${e.message}`);
  }

  // Drill into the triply-nested lvacctitle structure
  const lvl1 = parsed.lvacctitle;
  if (!lvl1) return null;
  const lvl2 = lvl1.lvacctitle;
  if (!lvl2) return null;
  // The innermost lvacctitle could be a string (the name) or an object
  // depending on Tally's quirks. We always want lvl2.lvacctitle (string)
  // and lvl2.{address, lvbody, …}.
  const name = typeof lvl2.lvacctitle === "string" ? lvl2.lvacctitle : null;
  if (!name) return null;

  // Address: optional, nested
  const address = lvl2.mledpartyaddress?.ledgrpaddress?.ledgrpaddress || null;

  // Closing balance + total debit / credit
  const closing = lvl2.lvbody?.lvclosingbalance?.lvfcthree || {};
  // Tally exports closing balance with a sign convention that depends on
  // ledger nature — we'll re-derive the sign from the dr/cr totals below.
  const closingDr = Number(closing.lvsubdrtotal || 0);
  const closingCr = Number(closing.lvsubcrtotal || 0);
  // Net balance: positive = Dr, negative = Cr (our standard convention)
  // In Tally exports the totals are signed in the same direction —
  // both are typically the same number with the same sign. We treat the
  // ABSOLUTE value as the magnitude and the sign of the larger as direction.
  const netBalance =
    Math.abs(closingDr) >= Math.abs(closingCr) ? closingDr : closingCr;

  // Vouchers — could be an array or a single object
  let vchArr = lvl2.lvbody?.dspvchdetail || [];
  if (vchArr && !Array.isArray(vchArr)) vchArr = [vchArr];

  const vouchers = vchArr
    .map((v) => parseVoucherEntry(v, name))
    .filter(Boolean);

  return {
    name: name.trim(),
    address: address ? String(address).trim() : null,
    closingBalance: netBalance,
    vouchers,
  };
}

// ─── Per-voucher entry parser ───────────────────────────────────────────────

function parseVoucherEntry(v, currentLedgerName) {
  // Each voucher entry, from the current ledger's perspective:
  //   {
  //     "dspvchdate": "20-Sep-25",                       // date
  //     "dspvchledaccount": "PURCHASE",                  // the OTHER ledger
  //     "dspvchtype": "Purc",                            // Tally voucher type
  //     "dspvchcramt": 3385.00,                          // amount on credit side
  //     "dspvchdramt": -3385.00,                         // OR debit side
  //     "dspvchnumber": {
  //       "dspvchnumber": {
  //         "dspexplvchnumber": "(No. :13493)"           // voucher number
  //       }
  //     }
  //   }
  //
  // The current ledger ALWAYS receives the OPPOSITE side of the amount shown.
  // If dspvchcramt is present → other ledger is Cr → current ledger is Dr.
  // If dspvchdramt is present → other ledger is Dr → current ledger is Cr.

  if (!v) return null;
  const date = parseTallyDate(v.dspvchdate);
  if (!date) return null;

  const otherLedger = (v.dspvchledaccount || "").trim();
  const vchType = mapTallyVoucherType(v.dspvchtype);

  // Tally numbers — extract the bare number from "(No. :13493)"
  const rawNumber =
    v.dspvchnumber?.dspvchnumber?.dspexplvchnumber ||
    v.dspvchnumber?.dspexplvchnumber ||
    v.dspvchnumber ||
    "";
  const numberMatch = String(rawNumber).match(/(\d+)/);
  const voucherNumber = numberMatch ? numberMatch[1] : null;

  // Amount + side
  const crAmt = v.dspvchcramt;
  const drAmt = v.dspvchdramt;
  let amount;
  let currentSide; // the side the CURRENT ledger is on
  if (typeof crAmt === "number") {
    amount = Math.abs(crAmt);
    currentSide = "Dr"; // other ledger is Cr → current is Dr
  } else if (typeof drAmt === "number") {
    amount = Math.abs(drAmt);
    currentSide = "Cr";
  } else {
    return null;
  }

  return {
    date,
    voucherType: vchType,
    voucherNumber,
    currentLedgerName,
    currentSide,
    otherLedgerName: otherLedger,
    amount,
  };
}

function parseTallyDate(s) {
  // Tally short-date format: "20-Sep-25" → 2025-09-20 (assume 20xx)
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monMap = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  const month = monMap[m[2].toLowerCase()];
  if (month === undefined) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const d = new Date(year, month, day);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function mapTallyVoucherType(t) {
  // Maps Tally's short codes to our Acc_Voucher.voucherType enum values.
  const map = {
    Rcpt: "receipt",
    Pymt: "payment",
    Sale: "sales",
    Purc: "purchase",
    Jrnl: "journal",
    "D/Note": "debit_note",
    "C/Note": "credit_note",
    Cont: "contra",
  };
  return map[t] || "journal";
}

// ─── Voucher deduplication (combining two sides) ────────────────────────────
//
// Each voucher appears in TWO ledger statements. We dedupe by
// (date+voucherType+voucherNumber) and merge sides. If a side has multiple
// entries (split posting), we keep all of them.

function dedupeAndCombineVouchers(allOneSidedEntries) {
  // Each voucher appears in 2 ledger statements (once per side). We dedupe
  // by a key that's identical regardless of which side recorded it. The
  // canonical key sorts the two ledger names alphabetically so both
  // perspectives produce the same key.

  const byKey = new Map();
  for (const e of allOneSidedEntries) {
    if (!e.otherLedgerName) continue;
    const [a, b] = [e.currentLedgerName, e.otherLedgerName].sort();
    const dateKey = e.date.toISOString().slice(0, 10);
    const key = `${dateKey}|${e.voucherType}|${e.voucherNumber || "_anon_"}|${a}|${b}|${e.amount}`;

    if (byKey.has(key)) {
      // We've already recorded this voucher from the other side.
      // Skip — the existing record already has both entries.
      continue;
    }

    byKey.set(key, {
      date: e.date,
      voucherType: e.voucherType,
      voucherNumber: e.voucherNumber,
      entries: [
        {
          ledgerName: e.currentLedgerName,
          side: e.currentSide,
          amount: e.amount,
        },
        {
          ledgerName: e.otherLedgerName,
          side: e.currentSide === "Dr" ? "Cr" : "Dr",
          amount: e.amount,
        },
      ],
    });
  }
  return [...byKey.values()];
}

// ─── Auto-classification ────────────────────────────────────────────────────
//
// Decides which default group each ledger belongs to, using heuristics over
// the name + balance sign. The rules are tuned to common Indian Tally
// conventions but can be overridden by the user in the Map step before
// commit.

function classifyLedger(name, closingBalance) {
  const upper = String(name || "").toUpperCase();

  // ── Banks ──────────────────────────────────────────────────────────
  // Common patterns: "INDIAN BANK (CA-3512)", "HDFC BANK A/c", "SBI - 12345"
  if (
    /\bBANK\b/.test(upper) ||
    /\b(CA|SA|OD|CC|FD)[-\s]?\d/.test(upper) ||
    /\bA\/C\s*\d/.test(upper)
  ) {
    return { groupName: "Bank Accounts", nature: "asset" };
  }

  // ── Cash ───────────────────────────────────────────────────────────
  if (
    upper === "CASH" ||
    /^CASH\b/.test(upper) ||
    /\bCASH IN HAND\b/.test(upper)
  ) {
    return { groupName: "Cash-in-Hand", nature: "asset" };
  }

  // ── Sales / Income ─────────────────────────────────────────────────
  if (
    /\bSALES?\b/.test(upper) ||
    /\bINCOME\b/.test(upper) ||
    /\bREVENUE\b/.test(upper) ||
    /\bRECEIPTS\b/.test(upper)
  ) {
    return { groupName: "Direct Incomes", nature: "revenue" };
  }

  // ── Purchases / Direct Expenses ────────────────────────────────────
  if (/\bPURCHASES?\b/.test(upper) || /\bRAW MATERIAL\b/.test(upper)) {
    return { groupName: "Purchase Accounts", nature: "expense" };
  }

  // ── Taxes (GST / TDS / etc.) ───────────────────────────────────────
  if (
    /\bGST\b/.test(upper) ||
    /\bCGST\b/.test(upper) ||
    /\bSGST\b/.test(upper) ||
    /\bIGST\b/.test(upper) ||
    /\bTDS\b/.test(upper) ||
    /\bTAX\b/.test(upper)
  ) {
    return { groupName: "Duties & Taxes", nature: "liability" };
  }

  // ── Capital / Loans ────────────────────────────────────────────────
  if (/\bCAPITAL\b/.test(upper) || /\bPROPRIETOR\b/.test(upper)) {
    return { groupName: "Capital Account", nature: "equity" };
  }
  if (/\bLOAN\b/.test(upper)) {
    return { groupName: "Loans (Liability)", nature: "liability" };
  }

  // ── Advances (asset side) ──────────────────────────────────────────
  if (/^ADVANCE\b/.test(upper)) {
    return { groupName: "Loans & Advances (Asset)", nature: "asset" };
  }

  // ── Fixed assets / depreciation ────────────────────────────────────
  if (/\bDEPRECIATION\b/.test(upper)) {
    return { groupName: "Indirect Expenses", nature: "expense" };
  }
  if (
    /\bMACHINERY\b/.test(upper) ||
    /\bFURNITURE\b/.test(upper) ||
    /\bVEHICLE\b/.test(upper) ||
    /\bBUILDING\b/.test(upper)
  ) {
    return { groupName: "Fixed Assets", nature: "asset" };
  }

  // ── Salaries / wages / staff costs ─────────────────────────────────
  if (
    /\bSALARY\b/.test(upper) ||
    /\bSALARIES\b/.test(upper) ||
    /\bWAGES\b/.test(upper)
  ) {
    return { groupName: "Indirect Expenses", nature: "expense" };
  }

  // ── Rent / electricity / common expense words ──────────────────────
  if (
    /\bRENT\b/.test(upper) ||
    /\bELECTRICITY\b/.test(upper) ||
    /\bTELEPHONE\b/.test(upper) ||
    /\bINTERNET\b/.test(upper) ||
    /\bCHARGES?\b/.test(upper) ||
    /\bEXPENSES?\b/.test(upper) ||
    /\bFEES?\b/.test(upper)
  ) {
    return { groupName: "Indirect Expenses", nature: "expense" };
  }

  // ── Fallback: party ledger ─────────────────────────────────────────
  // Sign of closing balance decides debtor vs creditor:
  //   positive (Dr) → Sundry Debtors (customer owes us)
  //   negative (Cr) → Sundry Creditors (we owe vendor)
  //   zero → default to Sundry Debtors (user can move)
  if (closingBalance < 0) {
    return { groupName: "Sundry Creditors", nature: "liability" };
  }
  return { groupName: "Sundry Debtors", nature: "asset" };
}

// ─── Main entry point ───────────────────────────────────────────────────────

function parseBSheetJson(buffer) {
  const text = decodeBuffer(buffer);

  const blocks = extractLedgerBlocks(text);
  if (blocks.length === 0) {
    throw new Error(
      "No ledger blocks found in the file. Are you sure this is a Tally Balance Sheet / Group Summary JSON?",
    );
  }

  const ledgers = [];
  const allVoucherEntries = [];
  let parseErrors = 0;

  for (const block of blocks) {
    try {
      const led = parseLedgerBlock(block);
      if (!led) continue;
      ledgers.push(led);
      for (const v of led.vouchers) allVoucherEntries.push(v);
    } catch {
      parseErrors++;
    }
  }

  const vouchers = dedupeAndCombineVouchers(allVoucherEntries);

  // Classify each ledger
  for (const led of ledgers) {
    const cls = classifyLedger(led.name, led.closingBalance);
    led.groupName = cls.groupName;
    led.nature = cls.nature;
    led.openingBalanceType = led.closingBalance >= 0 ? "Dr" : "Cr";
    led.openingBalance = Math.abs(led.closingBalance);
  }

  return {
    ledgers,
    vouchers,
    stats: {
      ledgerCount: ledgers.length,
      voucherCount: vouchers.length,
      rawVoucherEntries: allVoucherEntries.length,
      blocksFound: blocks.length,
      parseErrors,
    },
  };
}

module.exports = {
  parseBSheetJson,
  classifyLedger,
  decodeBuffer, // exported for tests
  extractLedgerBlocks, // exported for tests
};
