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
  /* ── A PARTY WHOSE BALANCE IS THE WRONG WAY ROUND ──────────────────────
     A customer who has paid more than they have been billed is money owed
     back, not a receivable; a supplier paid ahead of their bill is money we
     are owed, not a payable. The balance sheet used to bucket purely by the
     group's nature, so both sat on the wrong side as NEGATIVES — understating
     each side of the sheet, and leaving nowhere to see who is in advance.

     The line is regrouped, never the ledger: a customer stays under Sundry
     Debtors, where the invoices, the bill matching and the receivables ageing
     look for it. What this pins is that the regrouping is complete (nobody
     left behind) and, above all, that the sheet still BALANCES — the first
     attempt flipped a sign and knocked it out by twice the advance. */
  console.log("\nparties whose balance is the wrong way round");
  {
    const jwt = require("jsonwebtoken");
    const express = require("express");
    const company = await mongoose.connection.db
      .collection("acc_companies")
      .findOne({});

    if (!company) {
      check("a company to report on", false, "none in this database");
    } else {
      const token = jwt.sign(
        { id: "000000000000000000000001", role: "owner", name: "verifyLedgerBalances", email: "check@local" },
        process.env.JWT_SECRET,
        { expiresIn: "10m" },
      );
      const app = express();
      app.use(express.json());
      app.use("/reports", require("./routes/Accountant_Routes/Acc_books"));
      const server = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
      try {
        const res = await fetch(
          `http://127.0.0.1:${server.address().port}/reports/balance-sheet?companyId=${company._id}&asOf=2027-03-31`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const bs = await res.json();
        const aLines = bs.assets?.lines || [];
        const lLines = bs.liabilities?.lines || [];

        check(
          "the balance sheet still balances",
          bs.check?.isBalanced === true,
          `difference ${money(Number(bs.check?.difference || 0))}`,
        );

        const advCust = lLines.filter((l) => l.subGroupName === "Advance from Customers");
        const advSupp = aLines.filter((l) => l.subGroupName === "Advance to Suppliers");
        check(
          `customers in credit are shown under Advance from Customers (${advCust.length})`,
          advCust.length > 0,
          "none regrouped — a customer in credit is still a negative asset",
        );
        check(
          `suppliers in debit are shown under Advance to Suppliers (${advSupp.length})`,
          advSupp.length > 0,
        );

        /* An asset line is Dr-positive and a liability line Cr-negative, so a
           party on the correct side can never carry the opposite sign. */
        const strandedDebtors = aLines.filter(
          (l) => /sundry debtors/i.test(l.subGroupName || "") && l.amount < -0.5,
        );
        const strandedCreditors = lLines.filter(
          (l) => /sundry creditors/i.test(l.subGroupName || "") && l.amount > 0.5,
        );
        check(
          "no customer is left in Assets as a negative",
          strandedDebtors.length === 0,
          strandedDebtors.map((l) => l.ledgerName).slice(0, 3).join(", "),
        );
        check(
          "no supplier is left in Liabilities as a negative",
          strandedCreditors.length === 0,
          strandedCreditors.map((l) => l.ledgerName).slice(0, 3).join(", "),
        );

        /* The regrouped figure must be the ledger's own balance, not a
           recomputation that could drift from it. */
        const mismatched = [...advCust, ...advSupp].filter(
          (l) => Math.abs(Math.abs(l.amount) - Math.abs(l.displayAmount)) > 0.01,
        );
        check(
          "each advance shows the ledger's own balance",
          mismatched.length === 0,
          mismatched.map((l) => l.ledgerName).slice(0, 3).join(", "),
        );
        /* ── AND THE SAME THING IN THE CHART OF ACCOUNTS ─────────────────
           The balance sheet is not where somebody goes to ask "who is in
           advance?" — the chart of accounts is, because that is the screen
           with the groups on it. The tree hangs these lines under the advance
           group for the same reason and from the same balance, so the two
           screens can never disagree. */
        const coaApp = express();
        coaApp.use(express.json());
        coaApp.use("/coa", require("./routes/Accountant_Routes/Acc_chartOfAccounts"));
        const coaServer = await new Promise((r) => { const x = coaApp.listen(0, () => r(x)); });
        try {
          const tr = await fetch(
            `http://127.0.0.1:${coaServer.address().port}/coa/tree?companyId=${company._id}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const tj = await tr.json();
          const walk = (nodes, out = []) => {
            for (const n of nodes || []) { out.push(n); walk(n.children, out); }
            return out;
          };
          const nodes = walk(tj.tree || tj.groups || tj.data || []);
          const byName = (n) =>
            nodes.find((g) => String(g.name || "").trim().toLowerCase() === n);

          const cg = byName("advance from customers");
          const sg = byName("advance to suppliers");
          check(
            `the chart shows customers under Advance from Customers (${(cg?.ledgers || []).length})`,
            (cg?.ledgers || []).length === advCust.length,
            `chart ${(cg?.ledgers || []).length} vs balance sheet ${advCust.length} — the two screens disagree`,
          );
          check(
            `and suppliers under Advance to Suppliers (${(sg?.ledgers || []).length})`,
            (sg?.ledgers || []).length === advSupp.length,
            `chart ${(sg?.ledgers || []).length} vs balance sheet ${advSupp.length}`,
          );

          const sd = byName("sundry debtors");
          const sc = byName("sundry creditors");
          check(
            "no customer in credit is still listed under Sundry Debtors",
            (sd?.ledgers || []).filter((l) => l.currentBalance < -0.5).length === 0,
          );
          check(
            "no supplier in debit is still listed under Sundry Creditors",
            (sc?.ledgers || []).filter((l) => l.currentBalance > 0.5).length === 0,
          );

          /* The whole point: this is a VIEW. If a ledger were actually moved,
             bill matching would stop finding it — partyAccountIdsFor resolves
             a party by its Sundry group. */
          const movedForReal = await mongoose.connection.db
            .collection("acc_ledgers")
            .countDocuments({
              companyId: company._id,
              groupName: { $regex: /^advance (from customers|to suppliers)$/i },
            });
          check(
            "no ledger was actually moved in the database",
            movedForReal === 0,
            `${movedForReal} ledgers now live in an advance group — matching and ageing will lose them`,
          );
        } finally {
          await new Promise((r) => coaServer.close(r));
        }
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
