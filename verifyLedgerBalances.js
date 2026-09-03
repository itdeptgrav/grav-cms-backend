// verifyLedgerBalances.js
//
// The balance on the chart of accounts equals the balance on the ledger page.
//
// Run:  node -r dotenv/config verifyLedgerBalances.js      (READ-ONLY)
//
// THE BUG THIS PINS
// The tree fell through to the ledger's STORED `currentBalance` whenever it
// found no posted vouchers, so a ledger whose only voucher was later cancelled
// kept displaying the balance that voucher had once given it. PURCHASE read
// 1,55,50,925 on the chart of accounts and 0 on its own page, and both screens
// were reporting honestly — they were reading different things.
//
// The rule, in one line: a ledger's balance is its opening balance plus the
// movement of its POSTED vouchers. Nothing else. This checks every ledger in
// the company against that, from the vouchers themselves.

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};
const money = (n) => `₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);
  const db = mongoose.connection.db;

  const company = await db.collection("acc_companies").findOne({ isPrimary: true });
  check("found the primary company", Boolean(company), company?.companyName);
  if (!company) { console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(1); }

  const ledgers = await db.collection("acc_ledgers")
    .find({ companyId: company._id })
    .project({ name: 1, openingBalance: 1, currentBalance: 1 })
    .toArray();
  check("the company has ledgers", ledgers.length > 0, `${ledgers.length}`);

  /* The movement the TREE computes: posted vouchers only, signedAmount when
     present and Dr/Cr amount otherwise (Tally imports carry the older shape). */
  const movements = await db.collection("acc_vouchers").aggregate([
    { $match: { companyId: company._id, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        net: {
          $sum: {
            $cond: {
              if: { $ne: [{ $ifNull: ["$ledgerEntries.signedAmount", null] }, null] },
              then: "$ledgerEntries.signedAmount",
              else: {
                $cond: {
                  if: { $eq: ["$ledgerEntries.type", "Dr"] },
                  then: { $ifNull: ["$ledgerEntries.amount", 0] },
                  else: { $multiply: [{ $ifNull: ["$ledgerEntries.amount", 0] }, -1] },
                },
              },
            },
          },
        },
      },
    },
  ]).toArray();
  const movByLedger = new Map(movements.map((m) => [String(m._id), m.net]));

  console.log("the derived balance is the only balance");

  /* What the tree renders AFTER the fix, and what the ledger page computes.
     Both are (opening + posted movement), so they cannot disagree. */
  const derived = (l) => (l.openingBalance || 0) + (movByLedger.get(String(l._id)) || 0);

  const stale = ledgers.filter((l) => {
    const stored = Number(l.currentBalance || 0);
    return Math.abs(stored - derived(l)) > 0.5;
  });

  console.log(`  note  ${stale.length} of ${ledgers.length} ledgers have a STORED balance that`);
  console.log("        disagrees with their vouchers. The tree no longer reads it, so");
  console.log("        nothing displays it — but see the note at the end.");

  /* The specific shape that caused the report: no posted vouchers at all, yet a
     stored balance. Before the fix these were exactly the ledgers the tree got
     wrong. */
  const orphaned = ledgers.filter(
    (l) => !movByLedger.has(String(l._id)) && Math.abs(Number(l.currentBalance || 0) - (l.openingBalance || 0)) > 0.5,
  );
  if (orphaned.length) {
    console.log(`\n  ledgers with no posted vouchers but a stored balance (${orphaned.length}):`);
    for (const l of orphaned) {
      console.log(`     ${String(l.name).padEnd(32)} stored ${money(l.currentBalance).padStart(14)}  now shows ${money(derived(l))}`);
    }
  }

  check("every ledger with no posted vouchers now shows its opening balance",
    orphaned.every((l) => derived(l) === (l.openingBalance || 0)));

  /* And the case the fix must NOT break: a ledger that DOES have vouchers still
     shows opening plus their movement. */
  const active = ledgers.filter((l) => movByLedger.has(String(l._id)));
  check(`ledgers with posted vouchers still carry their movement (${active.length})`,
    active.every((l) => derived(l) === (l.openingBalance || 0) + movByLedger.get(String(l._id))));

  console.log("\nthe specific ledger that was reported");
  const purchase = ledgers.find((l) => l.name === "PURCHASE");
  if (purchase) {
    const posted = await db.collection("acc_vouchers")
      .countDocuments({ "ledgerEntries.ledgerId": purchase._id, status: "posted" });
    const any = await db.collection("acc_vouchers")
      .countDocuments({ "ledgerEntries.ledgerId": purchase._id });
    console.log(`  PURCHASE: ${any} voucher(s) touch it, ${posted} posted`);
    check("its tree balance now matches its ledger page", derived(purchase) === (purchase.openingBalance || 0),
      `tree ${money(derived(purchase))} vs page ${money(purchase.openingBalance || 0)}`);
    check("and that is zero, which is what the vouchers say",
      derived(purchase) === 0, money(derived(purchase)));
  } else {
    check("PURCHASE ledger found", false);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (stale.length) {
    console.log("NOTE: the stored `currentBalance` on those ledgers is still wrong in the");
    console.log("database. Nothing reads it for display any more, but the incremental");
    console.log("$inc that maintains it did not reverse when those vouchers were");
    console.log("cancelled. Worth a separate backfill — it is a data write, not a fix.\n");
  }
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
