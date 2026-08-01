/**
 * routes/CEO_Routes/booksPayments.js
 *
 * THE single source of payment truth for the CEO side: the accountant's books
 * (posted Acc_Voucher documents), never CustomerRequest.totalPaidAmount or
 * PurchaseOrder.payments. Everything here reads the books and *maps* books
 * parties onto ERP customers / vendors / orders:
 *
 *   Customer received  = Cr entries on that customer's Sundry Debtor ledger
 *                        in posted `receipt` vouchers (money in).
 *   Vendor paid        = Dr entries on that vendor's Sundry Creditor ledger
 *                        in posted `payment` vouchers (money out).
 *   Order attribution  = receipts whose voucherNumber / referenceNumber /
 *                        narration / billAllocations mention the order's
 *                        requestId; falls back to "the customer's only open
 *                        order"; otherwise stays customer-level.
 *
 * Ledger matching order (first hit wins, matchType records which):
 *   exact  — normalized ledger name or alias === normalized party name
 *   email  — ledger contactDetails.email === party email
 *   gstin  — ledger gstin === party gstin (vendors)
 *   fuzzy  — one normalized name contains the other (≥5 chars guard)
 *
 * The whole index is rebuilt at most once per TTL (60s) per process.
 */
"use strict";

const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Company,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");

const TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Every string on a voucher that could carry an order reference. */
function voucherRefBlob(v) {
  const parts = [v.voucherNumber, v.referenceNumber, v.narration];
  for (const e of v.ledgerEntries || []) {
    parts.push(e.narration);
    for (const b of e.billAllocations || []) parts.push(b.billName);
  }
  return norm(parts.filter(Boolean).join(" | "));
}

/**
 * Build (and cache) the books index for the active company:
 *  - debtor/creditor ledger maps keyed by normalized name/alias/email/gstin
 *  - per-ledger receipt/payment rollups with per-voucher ref blobs
 */
async function buildIndex() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const company =
    (await Acc_Company.findOne({ isActive: true })
      .select("_id companyName")
      .lean()) ||
    (await Acc_Company.findOne({}).select("_id companyName").lean());
  if (!company) {
    const empty = {
      company: null,
      debtors: [],
      creditors: [],
      byKey: new Map(),
      receiptsByLedger: new Map(),
      paymentsByLedger: new Map(),
    };
    cache = { at: Date.now(), data: empty };
    return empty;
  }

  const ledgers = await Acc_Ledger.find({
    companyId: company._id,
    groupName: { $regex: /sundry\s*(debtor|creditor)/i },
  })
    .select("name aliases groupName gstin contactDetails currentBalance currentBalanceType")
    .lean();

  const debtors = [];
  const creditors = [];
  // key space: "n:<normName>", "e:<email>", "g:<gstin>"
  const byKey = new Map();
  const addKey = (k, ledger) => {
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, ledger);
  };

  for (const l of ledgers) {
    const entry = {
      _id: String(l._id),
      name: l.name,
      groupName: l.groupName,
      isDebtor: /debtor/i.test(l.groupName || ""),
      normName: norm(l.name),
      normAliases: (l.aliases || []).map(norm).filter(Boolean),
      email: (l.contactDetails?.email || "").toLowerCase() || null,
      gstin: (l.gstin || "").toUpperCase() || null,
      // Ledger balances are signed Dr-positive. Debtor Dr balance = they owe
      // us; creditor Cr balance = we owe them.
      currentBalance: num(l.currentBalance),
    };
    (entry.isDebtor ? debtors : creditors).push(entry);
    addKey(`n:${entry.normName}`, entry);
    for (const a of entry.normAliases) addKey(`n:${a}`, entry);
    if (entry.email) addKey(`e:${entry.email}`, entry);
    if (entry.gstin) addKey(`g:${entry.gstin}`, entry);
  }

  // Money-moving vouchers only, posted only.
  const vouchers = await Acc_Voucher.find({
    companyId: company._id,
    status: "posted",
    voucherType: { $in: ["receipt", "payment"] },
  })
    .select(
      "voucherType voucherNumber referenceNumber narration voucherDate partyLedgerName ledgerEntries.ledgerName ledgerEntries.type ledgerEntries.amount ledgerEntries.narration ledgerEntries.billAllocations.billName",
    )
    .lean();

  const receiptsByLedger = new Map(); // normLedgerName -> { total, vouchers[] }
  const paymentsByLedger = new Map();

  for (const v of vouchers) {
    const isReceipt = v.voucherType === "receipt";
    const bucketMap = isReceipt ? receiptsByLedger : paymentsByLedger;
    // The party side of a receipt is the Cr entry; of a payment the Dr entry.
    const wantType = isReceipt ? "Cr" : "Dr";
    for (const e of v.ledgerEntries || []) {
      if (e.type !== wantType) continue;
      const key = norm(e.ledgerName);
      if (!key) continue;
      // Only count entries against party ledgers we actually indexed —
      // skips the bank/cash legs of the same voucher.
      if (!byKey.has(`n:${key}`)) continue;
      let bucket = bucketMap.get(key);
      if (!bucket) {
        bucket = { total: 0, vouchers: [] };
        bucketMap.set(key, bucket);
      }
      bucket.total += num(e.amount);
      bucket.vouchers.push({
        voucherNumber: v.voucherNumber,
        date: v.voucherDate,
        amount: num(e.amount),
        refBlob: voucherRefBlob(v),
        narration: v.narration || "",
      });
    }
  }

  const data = {
    company: { _id: company._id, name: company.companyName },
    debtors,
    creditors,
    byKey,
    receiptsByLedger,
    paymentsByLedger,
  };
  cache = { at: Date.now(), data };
  return data;
}

/** Match a party ({name, email, gstin}) to a ledger; wantDebtor selects side. */
function matchLedger(index, { name, email, gstin }, wantDebtor) {
  const pool = wantDebtor ? index.debtors : index.creditors;
  const nName = norm(name);

  const exact = index.byKey.get(`n:${nName}`);
  if (exact && exact.isDebtor === wantDebtor)
    return { ledger: exact, matchType: "exact" };

  if (email) {
    const byEmail = index.byKey.get(`e:${String(email).toLowerCase()}`);
    if (byEmail && byEmail.isDebtor === wantDebtor)
      return { ledger: byEmail, matchType: "email" };
  }
  if (gstin) {
    const byGst = index.byKey.get(`g:${String(gstin).toUpperCase()}`);
    if (byGst && byGst.isDebtor === wantDebtor)
      return { ledger: byGst, matchType: "gstin" };
  }

  if (nName.length >= 5) {
    let best = null;
    for (const l of pool) {
      const hit =
        l.normName.includes(nName) ||
        nName.includes(l.normName) ||
        l.normAliases.some((a) => a.includes(nName) || nName.includes(a));
      if (!hit) continue;
      // Prefer the longest ledger name (most specific) on multiple hits.
      if (!best || l.normName.length > best.normName.length) best = l;
    }
    if (best) return { ledger: best, matchType: "fuzzy" };
  }
  return { ledger: null, matchType: "none" };
}

/** All reference tokens that could identify an order inside a voucher blob. */
function orderRefTokens(requestId) {
  if (!requestId) return [];
  const raw = String(requestId);
  const tokens = new Set([norm(raw), norm(`MO-${raw}`)]);
  // "REQ-2026-0012" also matched as "req 2026 0012" by norm(); additionally
  // try the bare numeric tail ("0012" alone is too weak — keep year+seq).
  const m = raw.match(/(\d{4})[^0-9]*(\d+)\s*$/);
  if (m) tokens.add(norm(`${m[1]} ${m[2]}`));
  return [...tokens].filter((t) => t.length >= 6);
}

/**
 * Resolve books payments for one customer order.
 * @returns {{
 *  matchType, ledgerName, attribution: "reference"|"only_order"|"customer_level"|"none",
 *  orderPaid: number|null, customerReceived: number, customerOutstanding: number,
 *  matchedVouchers: Array
 * }}
 */
async function resolveOrderPayment(reqDoc, { customerOrderCount = null } = {}) {
  const index = await buildIndex();
  const party = {
    name: reqDoc.customerInfo?.name || reqDoc.measurementName,
    email: reqDoc.customerInfo?.email,
  };
  const { ledger, matchType } = matchLedger(index, party, true);
  if (!ledger)
    return {
      matchType: "none",
      ledgerName: null,
      attribution: "none",
      orderPaid: null,
      customerReceived: 0,
      customerOutstanding: 0,
      matchedVouchers: [],
    };

  const bucket = index.receiptsByLedger.get(ledger.normName) || {
    total: 0,
    vouchers: [],
  };
  const tokens = orderRefTokens(reqDoc.requestId);
  const refHits = bucket.vouchers.filter((v) =>
    tokens.some((t) => v.refBlob.includes(t)),
  );

  let attribution = "customer_level";
  let orderPaid = null;
  if (refHits.length) {
    attribution = "reference";
    orderPaid = refHits.reduce((s, v) => s + v.amount, 0);
  } else if (customerOrderCount === 1) {
    attribution = "only_order";
    orderPaid = bucket.total;
  }

  return {
    matchType,
    ledgerName: ledger.name,
    attribution,
    orderPaid,
    customerReceived: bucket.total,
    // Debtor ledger: positive (Dr) balance = still owed to us.
    customerOutstanding: Math.max(0, ledger.currentBalance),
    matchedVouchers: (refHits.length ? refHits : bucket.vouchers)
      .slice(-10)
      .map((v) => ({
        voucherNumber: v.voucherNumber,
        date: v.date,
        amount: v.amount,
        narration: v.narration,
      })),
  };
}

/** Books totals for a list of vendors ({companyName, gstNumber, email}). */
async function resolveVendorPayments(vendors) {
  const index = await buildIndex();
  return vendors.map((vend) => {
    const { ledger, matchType } = matchLedger(
      index,
      {
        name: vend.companyName || vend.name,
        email: vend.email,
        gstin: vend.gstNumber || vend.gstin,
      },
      false,
    );
    if (!ledger)
      return {
        vendorId: vend._id,
        vendorName: vend.companyName || vend.name,
        matchType: "none",
        ledgerName: null,
        paid: 0,
        outstanding: 0,
        recentVouchers: [],
      };
    const bucket = index.paymentsByLedger.get(ledger.normName) || {
      total: 0,
      vouchers: [],
    };
    return {
      vendorId: vend._id,
      vendorName: vend.companyName || vend.name,
      matchType,
      ledgerName: ledger.name,
      paid: bucket.total,
      // Creditor ledger: negative (Cr) balance = we still owe them.
      outstanding: Math.max(0, -ledger.currentBalance),
      recentVouchers: bucket.vouchers.slice(-5).map((v) => ({
        voucherNumber: v.voucherNumber,
        date: v.date,
        amount: v.amount,
        narration: v.narration,
      })),
    };
  });
}

/** Company-wide books money summary + per-party rollups for the Finance tab. */
async function booksSummary() {
  const index = await buildIndex();
  const sumSide = (map, pool) =>
    pool.map((l) => {
      const bucket = map.get(l.normName) || { total: 0, vouchers: [] };
      return {
        ledgerName: l.name,
        total: bucket.total,
        voucherCount: bucket.vouchers.length,
        lastAt: bucket.vouchers.length
          ? bucket.vouchers[bucket.vouchers.length - 1].date
          : null,
        outstanding: l.isDebtor
          ? Math.max(0, l.currentBalance)
          : Math.max(0, -l.currentBalance),
      };
    });

  const received = sumSide(index.receiptsByLedger, index.debtors)
    .filter((r) => r.total > 0 || r.outstanding > 0)
    .sort((a, b) => b.total - a.total);
  const paid = sumSide(index.paymentsByLedger, index.creditors)
    .filter((r) => r.total > 0 || r.outstanding > 0)
    .sort((a, b) => b.total - a.total);

  return {
    company: index.company,
    totalReceived: received.reduce((s, r) => s + r.total, 0),
    totalPaidOut: paid.reduce((s, r) => s + r.total, 0),
    totalReceivable: received.reduce((s, r) => s + r.outstanding, 0),
    totalPayable: paid.reduce((s, r) => s + r.outstanding, 0),
    receivedByCustomer: received.slice(0, 50),
    paidByVendor: paid.slice(0, 50),
  };
}

module.exports = {
  buildIndex,
  matchLedger,
  resolveOrderPayment,
  resolveVendorPayments,
  booksSummary,
};
