#!/usr/bin/env node
"use strict";

/**
 * REPAIR: matched advances counted twice (16 Oct 2026 audit).
 *
 * Until billMatching.service.js was fixed, matching an advance receipt or
 * payment to a bill KEPT the advance row for its whole amount and added the
 * settlement beside it. The bill-wise views (parties list, ageing, the ledger
 * page's buckets) then showed the advance as still open while the ledger was
 * nil. This rewrites each such party line exactly as the fixed matcher now
 * would: the advance keeps its name and holds only what is still unmatched
 * (line amount − settlements); any "on account" row beside it is dropped,
 * because the advance now carries that remainder.
 *
 * Only `ledgerEntries[].billAllocations` of affected POSTED vouchers change.
 * No amount, no ledger balance, no date. Dry run unless --apply is given.
 *
 *   node scripts/repair-matched-advances.js            # show what would change
 *   node scripts/repair-matched-advances.js --apply    # write it
 */

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
  const vouchers = await Acc_Voucher.find({
    status: "posted",
    "ledgerEntries.billAllocations.billType": "advance",
  });
  let changed = 0;
  for (const v of vouchers) {
    let touched = false;
    for (const e of v.ledgerEntries) {
      const rows = e.billAllocations || [];
      const advances = rows.filter((a) => a.billType === "advance");
      const settled = money(rows.filter((a) => a.billType === "agst_ref" && a.billName).reduce((s, a) => s + (a.amount || 0), 0));
      if (!advances.length || settled <= 0) continue;
      const remainder = Math.max(money((e.amount || 0) - settled), 0);
      const before = rows.map((a) => `${a.billType}:${a.billName || "-"}:${a.amount}`).join(", ");
      const kept = rows
        .filter((a) => a.billType !== "advance" && a.billType !== "on_account")
        .map((a) => (a.toObject ? a.toObject() : a));
      advances.forEach((a, i) => {
        const row = { billName: a.billName, billType: "advance", amount: i === 0 ? remainder : 0 };
        if (a.dueDate) row.dueDate = a.dueDate;
        if (a.creditDays != null) row.creditDays = a.creditDays;
        kept.push(row);
      });
      const after = kept.map((a) => `${a.billType}:${a.billName || "-"}:${a.amount}`).join(", ");
      console.log(`${v.voucherType} ${v.voucherNumber} · ${e.ledgerName}\n   before: ${before}\n   after:  ${after}`);
      e.billAllocations = kept;
      touched = true;
    }
    if (touched) {
      changed++;
      if (APPLY) {
        v.markModified("ledgerEntries");
        /* only the allocations change; the period-lock guard treats a save as
           a figure change, so mark it exempt the way billMatching does */
        v.$locals.periodLockExempt = true;
        await v.save();
      }
    }
  }
  console.log(`\n${changed} voucher(s) ${APPLY ? "repaired" : "would be repaired — run with --apply to write"}.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
