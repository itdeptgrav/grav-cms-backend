// services/tallyDayBookImporter.service.js
//
// TALLY DAY BOOK JSON IMPORTER  (vouchers / transactions)
// ─────────────────────────────────────────────────────────────────────────────
// Exported from: Gateway of Tally → Display More Reports → Day Book
//                → (set full-year period via Alt+F2) → Alt+E
//                → Format: JSON, Format of Report: DETAILED, All Vouchers
//
// This is the BEST transaction source — far cleaner than the Group-Summary
// drill-down. Verified against a real 36 MB GRAV export (589 vouchers).
//
// STRUCTURE (verified)
// ────────────────────
//   { "tallymessage": [
//       { "metadata": { "type": "Voucher", "vchtype": "Sales" },
//         "date": "20250804",                       // YYYYMMDD
//         "vouchernumber": "R&C/003/25-26",
//         "partyledgername": "Mayfair Bay Of Resort",
//         "partygstin": "21AAECM6873E1ZL",
//         "placeofsupply": "Odisha",
//         // Party + tax lines:
//         "ledgerentries":  [ { "ledgername": "...", "amount": "-243432.00",
//                               "isdeemedpositive": true } , ... ],
//         // (Payment/Receipt/Journal use this key instead:)
//         "allledgerentries": [ { "ledgername": "...", "amount": "145000.00" } ],
//         // Goods value (Sales/Purchase invoices) lives here:
//         "allinventoryentries": [ { "accountingallocations":
//                               [ { "ledgername": "Sales Account",
//                                   "amount": "231840.00" } ] } ]
//       }, ...
//   ] }
//
// KEY FACTS (each one a real bug if missed):
//
//   1. `tallymessage` is a clean JSON array — JSON.parse works. (Same shape
//      as the Masters export, NOT the mlvledbody Balance-Sheet shape — that
//      is why the old B-Sheet parser said "No ledger blocks found".)
//
//   2. A voucher's postings come from up to THREE places and ALL must be
//      collected or the voucher won't balance:
//        • ledgerentries[]                              (Sales/Purchase: party+tax)
//        • allledgerentries[]                           (Payment/Receipt/Journal)
//        • allinventoryentries[].accountingallocations[] (goods → income/expense)
//      With all three, every one of the 589 real vouchers nets to 0.00.
//
//   3. Sign convention: Tally `amount` string — NEGATIVE = Debit,
//      POSITIVE = Credit. (Verified: a customer on a Sales invoice carries a
//      negative amount and a sale debits the customer.)
//
//   4. Entry lists may be a single object instead of an array.
//
//   5. Amounts are strings with optional commas/sign ("-2,43,432.00").
//
// API:
//   parseDayBookJson(buffer) → { vouchers, ledgers, stats }
//     voucher = { date:Date, voucherType, voucherNumber, partyName,
//                 partyGstin, placeOfSupply,
//                 entries:[ { ledgerName, side:"Dr"|"Cr", amount } ] }
//     ledgers = distinct ledger names seen in vouchers (for stub awareness)

function decodeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const attempts = [];
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    attempts.push(buffer.slice(2).toString("utf16le"));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const sw = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2)
      if (i + 1 < buffer.length) {
        sw[i - 2] = buffer[i + 1];
        sw[i - 1] = buffer[i];
      }
    attempts.push(sw.toString("utf16le"));
  }
  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00)
    attempts.push(buffer.toString("utf16le"));
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  )
    attempts.push(buffer.slice(3).toString("utf8"));
  attempts.push(buffer.toString("utf8"));
  for (const t of attempts)
    if (t && (/"\s*tallymessage\s*"/i.test(t) || /"\s*metadata\s*"/i.test(t)))
      return t;
  return attempts.find((t) => t && t.length > 0) || buffer.toString("utf8");
}

function num(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  const neg = str.startsWith("-");
  const cleaned = str.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return neg ? -Math.abs(n) : n;
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function parseTallyYmd(s) {
  // "20250804" → Date(2025-08-04)
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Pull every accounting line out of a voucher, from all three possible
// containers. Returns [{ ledgerName, amount(signed: -ve Dr, +ve Cr) }].
function collectVoucherLines(v) {
  const lines = [];

  for (const key of ["ledgerentries", "allledgerentries"]) {
    for (const e of asArray(v[key])) {
      if (!e || e.ledgername == null) continue;
      lines.push({
        ledgerName: String(e.ledgername).trim(),
        amount: num(e.amount),
      });
    }
  }

  for (const it of asArray(v.allinventoryentries)) {
    if (!it) continue;
    for (const a of asArray(it.accountingallocations)) {
      if (!a || a.ledgername == null) continue;
      lines.push({
        ledgerName: String(a.ledgername).trim(),
        amount: num(a.amount),
      });
    }
  }

  // Merge duplicate ledger lines within the same voucher (Tally sometimes
  // splits the same ledger across rows). Net them so the posting is clean.
  const merged = new Map();
  for (const l of lines) {
    if (!l.ledgerName) continue;
    merged.set(l.ledgerName, (merged.get(l.ledgerName) || 0) + l.amount);
  }
  const out = [];
  for (const [ledgerName, amt] of merged) {
    if (Math.abs(amt) < 0.005) continue; // drop net-zero lines
    out.push({ ledgerName, amount: amt });
  }
  return out;
}

// Extract the STOCK ITEM lines from a voucher (Sales/Purchase/Debit Note
// etc. carry these inside allinventoryentries / inventoryentries). These
// are what the accountant wants to see on each invoice — "Mayfair Bay Of
// Resort" sale → Housekeeping Shirt, Executive Trouser, … with qty/rate.
// Tally encodes qty as " 16 Nos" and rate as "3500.00/Nos"; amount is a
// signed string ("-56000.00"); we normalise all three.
function parseQty(s) {
  if (s == null) return 0;
  const m = String(s).match(/-?\d[\d,]*\.?\d*/);
  return m ? parseFloat(m[0].replace(/,/g, "")) : 0;
}
function parseRate(s) {
  if (s == null) return 0;
  const m = String(s).match(/-?\d[\d,]*\.?\d*/);
  return m ? parseFloat(m[0].replace(/,/g, "")) : 0;
}
function unitOf(s) {
  if (s == null) return "";
  const m = String(s).match(/[A-Za-z]+\s*$/);
  return m ? m[0].trim() : "";
}

function extractInventory(v) {
  const items = [];
  const src = [];
  for (const it of asArray(v.allinventoryentries)) if (it) src.push(it);
  for (const it of asArray(v.inventoryentries)) if (it) src.push(it);
  for (const it of src) {
    const name =
      it.stockitemname != null ? String(it.stockitemname).trim() : "";
    if (!name) continue;
    const qty = Math.abs(parseQty(it.actualqty || it.billedqty));
    const rate = parseRate(it.rate);
    const amount = Math.abs(num(it.amount));
    let godown = "";
    let batch = "";
    for (const ba of asArray(it.batchallocations)) {
      if (!ba) continue;
      if (!godown && ba.godownname) godown = String(ba.godownname).trim();
      if (!batch && ba.batchname) batch = String(ba.batchname).trim();
    }
    // HSN/SAC code — Tally puts it in gsthsnname (sometimes hsncode).
    const hsn =
      it.gsthsnname != null && String(it.gsthsnname).trim()
        ? String(it.gsthsnname).trim()
        : it.hsncode != null
          ? String(it.hsncode).trim()
          : "";
    // GST rate (sum of CGST+SGST, or IGST) from ratedetails[].
    let cgstR = 0;
    let sgstR = 0;
    let igstR = 0;
    let cessR = 0;
    for (const rd of asArray(it.ratedetails)) {
      if (!rd) continue;
      const head = String(rd.gstratedutyhead || "").toLowerCase();
      const val = parseFloat(String(rd.gstrate || "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(val)) continue;
      if (head.includes("cgst")) cgstR = val;
      else if (head.includes("sgst") || head.includes("utgst")) sgstR = val;
      else if (head.includes("igst")) igstR = val;
      else if (head === "cess") cessR = val;
    }
    const taxRate = igstR > 0 ? igstR : cgstR + sgstR;
    items.push({
      stockItemName: name,
      quantity: qty || 0,
      unit: unitOf(it.actualqty || it.billedqty) || "",
      rate: rate || 0,
      amount: amount || 0,
      hsnCode: hsn || undefined,
      gstRate: taxRate || 0,
      cgstRate: cgstR || 0,
      sgstRate: sgstR || 0,
      igstRate: igstR || 0,
      cessRate: cessR || 0,
      godownName: godown || undefined,
      batchName: batch || undefined,
    });
  }
  // Tally can split one item across rows (same name) — merge qty/amount.
  const byName = new Map();
  for (const i of items) {
    const k = i.stockItemName.toLowerCase();
    if (!byName.has(k)) {
      byName.set(k, { ...i });
    } else {
      const e = byName.get(k);
      e.quantity += i.quantity;
      e.amount += i.amount;
      if (!e.rate && i.rate) e.rate = i.rate;
      if (!e.hsnCode && i.hsnCode) e.hsnCode = i.hsnCode;
      if (!e.gstRate && i.gstRate) e.gstRate = i.gstRate;
    }
  }
  return [...byName.values()];
}

const VCH_TYPE_MAP = {
  sales: "sales",
  purchase: "purchase",
  receipt: "receipt",
  payment: "payment",
  journal: "journal",
  contra: "contra",
  "debit note": "debit_note",
  "credit note": "credit_note",
  debit_note: "debit_note",
  credit_note: "credit_note",
};

function mapVoucherType(t) {
  const key = String(t || "")
    .trim()
    .toLowerCase();
  return VCH_TYPE_MAP[key] || "journal";
}

function parseDayBookJson(buffer) {
  const text = decodeBuffer(buffer);
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    throw new Error(
      "Couldn't read the Day Book JSON. Re-export from Tally: Display More " +
        "Reports → Day Book → Alt+E → Format JSON, Format of Report = Detailed.",
    );
  }

  const tm = root && root.tallymessage;
  const objects = [];
  const visit = (n) => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (n && typeof n === "object") {
      const md = n.metadata;
      if (md && typeof md === "object") objects.push(n);
    }
  };
  if (tm !== undefined) visit(tm);
  else visit(root);

  const voucherObjs = objects.filter(
    (o) => o.metadata && o.metadata.type === "Voucher",
  );

  if (voucherObjs.length === 0) {
    throw new Error(
      "No vouchers found in this file. Make sure it's a Tally Day Book " +
        "export (Display More Reports → Day Book → Alt+E → JSON), not a " +
        "Balance Sheet summary.",
    );
  }

  const vouchers = [];
  const ledgerNames = new Set();
  let skippedNoEntries = 0;
  let skippedUnbalanced = 0;

  for (const v of voucherObjs) {
    if (v.iscancelled === true || v.isdeleted === true) continue;
    if (v.isoptional === true) continue; // optional vouchers don't post

    const date = parseTallyYmd(v.date || v.effectivedate);
    if (!date) continue;

    const lines = collectVoucherLines(v);
    if (lines.length < 2) {
      skippedNoEntries++;
      continue;
    }

    // Balance guard: a real voucher nets to ~0. Allow ₹1 rounding.
    const net = lines.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(net) > 1) {
      skippedUnbalanced++;
      continue;
    }

    const entries = lines.map((l) => {
      // Tally sign: negative = Debit, positive = Credit.
      const side = l.amount < 0 ? "Dr" : "Cr";
      ledgerNames.add(l.ledgerName);
      return {
        ledgerName: l.ledgerName,
        side,
        amount: Math.abs(l.amount),
      };
    });

    vouchers.push({
      date,
      voucherType: mapVoucherType(
        (v.metadata && v.metadata.vchtype) || v.vouchertypename,
      ),
      voucherNumber: v.vouchernumber ? String(v.vouchernumber).trim() : null,
      partyName: v.partyledgername
        ? String(v.partyledgername).trim()
        : v.partyname
          ? String(v.partyname).trim()
          : null,
      partyGstin: v.partygstin ? String(v.partygstin).trim() : null,
      placeOfSupply: v.placeofsupply ? String(v.placeofsupply).trim() : null,
      entries,
      inventory: extractInventory(v),
    });
  }

  const typeDist = {};
  for (const v of vouchers)
    typeDist[v.voucherType] = (typeDist[v.voucherType] || 0) + 1;

  return {
    vouchers,
    ledgers: [...ledgerNames].map((name) => ({ name })),
    stats: {
      voucherCount: vouchers.length,
      ledgerCount: ledgerNames.size,
      voucherTypeDistribution: typeDist,
      skippedNoEntries,
      skippedUnbalanced,
      sourceVoucherObjects: voucherObjs.length,
    },
  };
}

// Cheap sniff so the route can tell a Day Book apart from the other exports.
function isDayBook(buffer) {
  try {
    const t = decodeBuffer(buffer).slice(0, 200000);
    if (!/"\s*tallymessage\s*"/i.test(t)) return false;
    // Day Book has Voucher objects; Masters does not.
    return /"type"\s*:\s*"Voucher"/.test(t);
  } catch {
    return false;
  }
}

module.exports = {
  parseDayBookJson,
  isDayBook,
  decodeBuffer, // tests
  collectVoucherLines, // tests
};
