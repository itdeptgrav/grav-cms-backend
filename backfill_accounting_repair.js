// backfill_accounting_repair.js
//
// Three data repairs the audit (auditAccounting.js) turned up. Dry by default.
//
//   node -r dotenv/config backfill_accounting_repair.js            # report only
//   node -r dotenv/config backfill_accounting_repair.js --apply    # write
//   ... --only=party|bills|balances                                # one repair
//
// ── 1. PARTY LEGS ARE NOT STAMPED ───────────────────────────────────────────
// A receipt's party line is identified by `isPartyLedger`, but Tally-imported
// vouchers never carried the flag. 72 receipts and payments whose credit line
// IS a Sundry Debtor were therefore invisible to the matching screen — it
// could not tell them apart from bank interest. The flag is set from the one
// thing that is unambiguous: the ledger's own group. `groupName` is copied
// onto the entry at the same time, because the register reads it to decide
// what to show and it was blank.
//
// ── 2. SETTLEMENTS WITH NO BILL BEHIND THEM ─────────────────────────────────
// 39 allocations settle an invoice that never established itself as a bill.
// The fold signs settlements negative, so each of these reads as a CREDIT the
// customer never had — a party who has paid can show as owed money. Where the
// invoice exists, it is given the bill reference its own number implies.
//
// ── 3. STORED LEDGER BALANCES HAVE DRIFTED ──────────────────────────────────
// 170 of 470 ledgers hold a `currentBalance` that disagrees with their own
// postings — some by lakhs. Anything reading the stored figure disagrees with
// anything recomputing it. Recomputed from opening balance + posted entries.
//
// Every repair is idempotent and reports exactly what it would touch first.

"use strict";

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "";
const want = (name) => !ONLY || ONLY === name;
const R = (n) => "₹" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-IN");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}`);
  console.log(APPLY ? "MODE: APPLY — writing changes\n" : "MODE: dry run — nothing will be written\n");

  const db = mongoose.connection.db;
  const V = db.collection("acc_vouchers");
  const L = db.collection("acc_ledgers");

  const ledgers = new Map(
    (await L.find({}).project({ name: 1, groupName: 1, openingBalance: 1, openingBalanceType: 1, currentBalance: 1 }).toArray())
      .map((l) => [String(l._id), l]),
  );
  const isPartyLedger = (e) => {
    const l = ledgers.get(String(e.ledgerId));
    return /sundry debtor|sundry creditor|debtor|creditor/i.test(l?.groupName || "");
  };

  /* ── 1. stamp party legs ─────────────────────────────────────────── */
  if (want("party")) {
    console.log("1. stamping party legs on receipts, payments and notes");
    /* Credit and debit notes settle bills exactly as receipts and payments do,
       so they need the same stamp. 17 of 21 notes had no party leg flagged,
       which made them silently unmatchable — the Match button opened on an
       empty list. */
    const vouchers = await V.find({
      voucherType: { $in: ["receipt", "payment", "credit_note", "debit_note"] },
      status: { $nin: ["cancelled", "void"] },
    }).toArray();

    let touched = 0, flagged = 0, grouped = 0, headers = 0;
    for (const v of vouchers) {
      /* Which side faces the party, per type — the same map the matching
         service uses. A receipt and a credit note both credit the customer;
         a payment and a debit note both debit the supplier. */
      const side = { receipt: "Cr", credit_note: "Cr", payment: "Dr", debit_note: "Dr" }[v.voucherType] || "Dr";
      let changed = false;
      const legs = [];

      for (const e of v.ledgerEntries || []) {
        const party = e.type === side && isPartyLedger(e);
        if (party) legs.push(e);
        if (party && e.isPartyLedger !== true) { e.isPartyLedger = true; flagged += 1; changed = true; }
        /* Never UNSET a flag somebody set deliberately — only fill blanks. */
        const l = ledgers.get(String(e.ledgerId));
        if (l?.groupName && !e.groupName) { e.groupName = l.groupName; grouped += 1; changed = true; }
      }

      /* A voucher with exactly one party leg gets its header fields too, so
         anything reading partyLedgerId (the register, the reports) agrees
         with the entries. Several legs is left alone: there is no single
         party to name, and inventing one would be a lie. */
      const update = {};
      if (legs.length === 1 && !v.partyLedgerId) {
        update.partyLedgerId = legs[0].ledgerId;
        update.partyLedgerName = legs[0].ledgerName;
        headers += 1;
        changed = true;
      }

      if (changed) {
        touched += 1;
        if (APPLY) {
          await V.updateOne(
            { _id: v._id },
            { $set: { ledgerEntries: v.ledgerEntries, ...update } },
          );
        }
      }
    }
    console.log(`   ${touched} vouchers ${APPLY ? "updated" : "would be updated"}`);
    console.log(`     ${flagged} party legs flagged · ${grouped} group names filled · ${headers} vouchers given a party header\n`);
  }

  /* ── 2. give orphan settlements their bill ───────────────────────── */
  if (want("bills")) {
    console.log("2. settlements with no original bill behind them");
    const posted = await V.find({ status: "posted" }).toArray();

    const bills = new Map(); // ledger||name -> { orig, settle, ledgerId, name }
    for (const v of posted) {
      for (const e of v.ledgerEntries || []) {
        for (const a of e.billAllocations || []) {
          if (!a.billName) continue;
          const k = `${String(e.ledgerId)}||${a.billName}`;
          if (!bills.has(k)) bills.set(k, { orig: 0, settle: 0, ledgerId: e.ledgerId, name: a.billName });
          const b = bills.get(k);
          if (a.billType === "new_ref") b.orig += a.amount || 0;
          else if (a.billType === "agst_ref") b.settle += a.amount || 0;
        }
      }
    }
    const orphans = [...bills.values()].filter((b) => b.settle > 0.5 && b.orig < 0.5);
    console.log(`   ${orphans.length} orphan bill(s)`);

    let repaired = 0, unfixable = [];
    for (const b of orphans) {
      /* The invoice that should have raised it: same number, same party. */
      const invoice = await V.findOne({
        voucherNumber: b.name,
        voucherType: { $in: ["sales", "purchase"] },
        status: "posted",
      });
      if (!invoice) { unfixable.push(`${b.name} — no invoice with that number`); continue; }

      const wantSide = invoice.voucherType === "sales" ? "Dr" : "Cr";
      const party =
        (invoice.ledgerEntries || []).find((e) => e.isPartyLedger && e.type === wantSide) ||
        (invoice.ledgerEntries || []).find(
          (e) => String(e.ledgerId) === String(b.ledgerId) && e.type === wantSide,
        );
      if (!party) { unfixable.push(`${b.name} — its invoice has no matching party line`); continue; }

      const already = (party.billAllocations || []).some(
        (a) => a.billType === "new_ref" && a.billName === b.name,
      );
      if (already) continue;

      party.billAllocations = [
        ...(party.billAllocations || []),
        {
          billName: b.name,
          billType: "new_ref",
          amount: Math.round((party.amount || invoice.grandTotal || 0) * 100) / 100,
          ...(invoice.dueDate ? { dueDate: invoice.dueDate } : {}),
        },
      ];
      repaired += 1;
      if (APPLY) {
        await V.updateOne({ _id: invoice._id }, { $set: { ledgerEntries: invoice.ledgerEntries } });
      }
    }
    console.log(`   ${repaired} ${APPLY ? "repaired" : "would be repaired"} by writing the invoice's own bill reference`);
    if (unfixable.length) {
      console.log(`   ${unfixable.length} cannot be repaired automatically:`);
      unfixable.slice(0, 8).forEach((u) => console.log(`     ${u}`));
      console.log("     (these settle a bill number no voucher in this database raised —");
      console.log("      most likely an opening balance carried in from Tally.)");
    }
    console.log("");
  }

  /* ── 3. recompute stored ledger balances ─────────────────────────── */
  if (want("balances")) {
    console.log("3. stored ledger balances that disagree with their postings");
    const posted = await V.find({ status: "posted" }).project({ ledgerEntries: 1 }).toArray();
    const moved = new Map();
    for (const v of posted) {
      for (const e of v.ledgerEntries || []) {
        if (!e.ledgerId) continue;
        const k = String(e.ledgerId);
        moved.set(k, (moved.get(k) || 0) + (e.type === "Dr" ? 1 : -1) * (e.amount || 0));
      }
    }

    let fixed = 0, biggest = [];
    for (const [id, l] of ledgers) {
      const opening = (l.openingBalance || 0) * (l.openingBalanceType === "Cr" ? -1 : 1);
      const expected = Math.round((opening + (moved.get(id) || 0)) * 100) / 100;
      const stored = Math.round((l.currentBalance || 0) * 100) / 100;
      if (Math.abs(expected - stored) <= 1) continue;
      fixed += 1;
      biggest.push({ name: l.name, stored, expected, diff: Math.abs(expected - stored) });
      if (APPLY) await L.updateOne({ _id: l._id }, { $set: { currentBalance: expected } });
    }
    biggest.sort((a, b) => b.diff - a.diff);
    console.log(`   ${fixed} ledger(s) ${APPLY ? "recomputed" : "would be recomputed"}; largest gaps:`);
    biggest.slice(0, 8).forEach((b) =>
      console.log(`     ${b.name}: ${R(b.stored)} → ${R(b.expected)}`),
    );
    console.log("");
  }

  console.log(APPLY
    ? "Done. Re-run auditAccounting.js to confirm.\n"
    : "Nothing was written. Re-run with --apply to make these changes.\n");
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error("\nbackfill crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
