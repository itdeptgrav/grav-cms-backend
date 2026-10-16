"use strict";

/**
 * A LEDGER'S BALANCE, ONE WAY (16 Oct 2026 audit).
 *
 * `Acc_Ledger.currentBalance` is a CACHE that writers keep by `$inc`. Several
 * paths never kept it (journal-entry and payroll mirroring, Tally import), so
 * on this company 186 of 489 ledgers carry a figure that is not their opening
 * plus their posted vouchers — "Salaries (Office Staff)" says −₹2.78 lakh
 * where its vouchers add to ₹92.9 lakh. The trial balance, the chart of
 * accounts and the ledger list already ignore the cache and recompute; this
 * is that computation, for every other place that read the cache — above all
 * "Transfer balance", which POSTED a journal for whatever the cache said.
 *
 * The opening balance has been written two ways: signed (the schema's
 * reading) and unsigned with the side in `openingBalanceType` (merges, some
 * imports). `openingSigned` is correct under both: a negative number is a
 * credit; a positive one is a credit only when it is marked "Cr".
 */

const mongoose = require("mongoose");

function openingSigned(ledger) {
  const ob = Number((ledger && ledger.openingBalance) || 0);
  if (!ob) return 0;
  if (ob < 0) return ob;
  return ledger.openingBalanceType === "Cr" ? -ob : ob;
}

/**
 * Posted, non-optional movement per ledger up to `asOf` (default: no bound).
 * → Map(ledgerId → { debit, credit, net }) — net = debit − credit.
 */
async function movementsOf(companyId, ledgerIds, { asOf = null } = {}) {
  const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
  const ids = (ledgerIds || [])
    .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  const out = new Map();
  if (!ids.length) return out;
  const match = {
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": { $in: ids },
  };
  if (asOf) match.voucherDate = { $lte: asOf };
  const rows = await Acc_Voucher.aggregate([
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        debit: { $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] } },
      },
    },
  ]);
  for (const r of rows) out.set(String(r._id), { debit: r.debit, credit: r.credit, net: r.debit - r.credit });
  return out;
}

/**
 * The balance of each ledger: opening + posted movement. `ledgers` are ledger
 * documents (they carry their opening). → Map(ledgerId → { balance, type }),
 * balance SIGNED (+ Dr, − Cr) like the cached currentBalance it replaces.
 */
async function liveBalances(companyId, ledgers, opts = {}) {
  const list = (ledgers || []).filter(Boolean);
  const moves = await movementsOf(companyId, list.map((l) => l._id), opts);
  const out = new Map();
  for (const l of list) {
    const m = moves.get(String(l._id));
    const balance = Math.round((openingSigned(l) + (m ? m.net : 0)) * 100) / 100;
    out.set(String(l._id), { balance, type: balance < 0 ? "Cr" : "Dr" });
  }
  return out;
}

/** One ledger's balance (signed: + Dr, − Cr). */
async function liveBalanceOf(ledger, opts = {}) {
  if (!ledger) return 0;
  const m = await liveBalances(ledger.companyId, [ledger], opts);
  return (m.get(String(ledger._id)) || { balance: 0 }).balance;
}

module.exports = { openingSigned, movementsOf, liveBalances, liveBalanceOf };
