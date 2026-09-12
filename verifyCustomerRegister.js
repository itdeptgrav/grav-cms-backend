// verifyCustomerRegister.js
//
// The accountant's customer register IS Sundry Debtors.
//
// Run:  node -r dotenv/config verifyCustomerRegister.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// The register used to be built from the CRM `customers` collection, with the
// accounting ledger joined on as an attachment. That made a storefront login
// record the identity of an accounting party, and the consequences were not
// subtle:
//
//   • A ledger linked to the wrong customer showed ANOTHER company's invoices,
//     receipts and balance under this customer's name, with nothing on screen
//     to suggest it.
//   • Parties with real trade and no CRM row were absent entirely — including
//     M/s Mayfair Hotels & Resorts Ltd.(CORPORATE) and its ₹12.4 lakh.
//   • Test accounts and this company itself were listed as customers.
//   • REVENUE and PAID were read off the closing BALANCE, so a customer who
//     had been invoiced ₹12,30,553 and had paid ₹12,30,554 showed "₹1 / ₹1".
//
// Every one of those is a symptom of the same thing: two collections answering
// different questions, joined by a link that could be wrong. The register now
// reads the ledger, so a mislink can no longer put anyone else's money on the
// page — the worst it can do is omit an email address.
//
// The invariant worth pinning, and the one this checks hardest, is that the
// page reconciles with the books: what the register says is owed must equal
// what the Sundry Debtors group says is owed. If those two ever disagree
// again, something has started reading from somewhere else.
//
// READ-ONLY. Serves the real route in-process against the dev database.

"use strict";

/* Before anything is required — the auth middleware reads this once, at load. */
process.env.ACCOUNTANT_AUTH_BYPASS = "true";

const mongoose = require("mongoose");

const R = (n) => "₹" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-IN");
const near = (a, b, tol = 1) => Math.abs((a || 0) - (b || 0)) <= tol;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);
  const db = mongoose.connection.db;

  const company = await db.collection("acc_companies").findOne({});
  if (!company) {
    console.log("(no company in this database — nothing to check)");
    await mongoose.disconnect();
    process.exit(0);
  }
  const cid = String(company._id);

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/c", require("./routes/Accountant_Routes/Acc_customers"));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/c`;

  try {
    const res = await fetch(`${base}/all?companyId=${cid}`);
    const j = await res.json();
    check("the register responds", res.status === 200 && j.success, `${res.status}`);

    /* The payload carries BOTH sides. The accounting register is the
       ledger-sourced half — what the Accounting Customers tab renders; the
       CRM half feeds the Sales / CRM tab and is checked separately below. */
    const all = j.customers || [];
    const rows = all.filter((r) => r.isImported);
    const crmRows = all.filter((r) => !r.isImported);

    /* ── one row per active Sundry Debtor, and nothing else ─────────── */
    console.log("\nthe register is exactly the Sundry Debtors group");
    const debtors = await db.collection("acc_ledgers")
      .find({ groupName: /sundry debtor/i, isActive: { $ne: false } })
      .project({ _id: 1, name: 1 }).toArray();
    check(`${debtors.length} active debtor ledgers, ${rows.length} rows`,
      rows.length === debtors.length, `${rows.length} vs ${debtors.length}`);

    const rowIds = new Set(rows.map((r) => String(r.ledgerId || r._id)));
    const missing = debtors.filter((d) => !rowIds.has(String(d._id)));
    check("every debtor ledger has a row", missing.length === 0,
      missing.map((d) => d.name).join(", "));

    check("every row is sourced from a ledger",
      rows.every((r) => r.source === "tally_ledger" && r.ledgerId),
      [...new Set(rows.map((r) => r.source))].join(","));

    /* The row's name is the LEDGER's name — that is the whole point. */
    const byId = new Map(debtors.map((d) => [String(d._id), d.name]));
    const misnamed = rows.filter((r) => byId.get(String(r.ledgerId)) !== r.name);
    check("every row is named by its own ledger", misnamed.length === 0,
      misnamed.slice(0, 3).map((r) => `"${r.name}" vs "${byId.get(String(r.ledgerId))}"`).join(" | "));

    /* ── it reconciles with the books ───────────────────────────────── */
    console.log("\nit reconciles with the Sundry Debtors group");
    const owed = rows.reduce((s, r) => s + (r.totalOutstanding || 0), 0);
    const credit = rows.reduce((s, r) => s + (r.ledgerCreditBalance || 0), 0);
    const netFromRows = owed - credit;

    /* The same figure computed straight from the vouchers, independently. */
    const ledgerIds = debtors.map((d) => d._id);
    const agg = await db.collection("acc_vouchers").aggregate([
      { $match: { status: "posted" } },
      { $unwind: "$ledgerEntries" },
      { $match: { "ledgerEntries.ledgerId": { $in: ledgerIds } } },
      { $group: {
        _id: null,
        dr: { $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] } },
        cr: { $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] } },
      } },
    ]).toArray();
    const opening = (await db.collection("acc_ledgers")
      .find({ _id: { $in: ledgerIds } })
      .project({ openingBalance: 1, openingBalanceType: 1 }).toArray())
      .reduce((s, l) => s + (l.openingBalanceType === "Cr" ? -1 : 1) * Math.abs(l.openingBalance || 0), 0);
    const netFromVouchers = opening + (agg[0]?.dr || 0) - (agg[0]?.cr || 0);

    console.log(`        register : ${R(netFromRows)}`);
    console.log(`        vouchers : ${R(netFromVouchers)}`);
    check("what the register says is owed equals what the books say",
      near(netFromRows, netFromVouchers, 2),
      `${R(netFromRows)} vs ${R(netFromVouchers)}`);

    check("revenue minus paid comes to the same number",
      near((j.summary.totalRevenue || 0) - (j.summary.totalPaid || 0), netFromVouchers, 2),
      `${R((j.summary.totalRevenue || 0) - (j.summary.totalPaid || 0))}`);

    check("the headline total matches the rows",
      near(j.summary.totalOutstanding, owed, 1) && j.summary.totalCustomers === rows.length);

    /* ── revenue is turnover, not a balance ─────────────────────────── */
    console.log("\nrevenue is what was billed, not what is left over");
    const settled = rows.filter((r) => r.totalOutstanding < 1 && r.voucherCount > 3);
    if (settled.length) {
      const worst = settled.sort((a, b) => b.voucherCount - a.voucherCount)[0];
      console.log(`        ${worst.name} — ${worst.voucherCount} vouchers, nothing outstanding`);
      check("a fully-settled customer still shows the revenue it was billed",
        worst.totalRevenue > 1000,
        `revenue ${R(worst.totalRevenue)} (a balance-based figure would be ~₹0)`);
      check("and shows what they actually paid, not their credit balance",
        worst.totalPaid > 1000, R(worst.totalPaid));
    }
    check("no row reports paid as a tiny leftover while carrying real trade",
      !rows.some((r) => r.voucherCount > 5 && r.totalRevenue > 0 && r.totalRevenue < 10),
      rows.filter((r) => r.voucherCount > 5 && r.totalRevenue > 0 && r.totalRevenue < 10)
        .map((r) => `${r.name} ${R(r.totalRevenue)}`).join(", "));

    /* ── the Sales / CRM tab still has something to show ────────────── */
    console.log("\nthe Sales / CRM tab was never broken and is still served");
    const crmTotal = await db.collection("customers").countDocuments({ isActive: { $ne: false } });
    check("CRM customers are still sent", crmRows.length > 0, `${crmRows.length}`);
    check("all of them, not just the ones without a ledger",
      crmRows.length === crmTotal, `${crmRows.length} sent vs ${crmTotal} in the collection`);
    check("none of them is ledger-sourced",
      crmRows.every((r) => r.source !== "tally_ledger"));
    /* A party may appear on both TABS — its orders on Sales, its ledger on
       Accounting — but never as the same row doing both jobs. */
    const ids = new Set(rows.map((r) => String(r._id)));
    check("no row is on both sides at once",
      !crmRows.some((c) => ids.has(String(c._id))));

    /* ── EVERY ROW ON THE PAGE MUST OPEN ────────────────────────────────
       The register's row ids became LEDGER ids when it started reading Sundry
       Debtors. The detail route's ledger fallback was gated on
       `!ledger.linkedCustomerId` — written when it only had to serve Tally
       parties with no CRM account — so the eighteen rows whose ledger IS
       linked fell past it and answered "Customer not found" for parties
       plainly listed one click earlier, balances and all.

       A list that offers a link is a promise the link works, so this follows
       every one of them. Serially: 54 rows times four endpoints at once was
       enough concurrency to knock over the test server, which is a fact about
       the harness rather than the route. */
    console.log("\nevery row on the register actually opens");
    let opened = 0;
    const dead = [];
    for (const r of all) {
      const res1 = await fetch(`${base}/${r._id}?companyId=${cid}`);
      if (res1.status !== 200) {
        dead.push(`${r.name}: detail ${res1.status}`);
        continue;
      }
      const body = await res1.json();
      /* And it must open as ITSELF. A detail page headed with a different
         party's name is the bug this whole change set exists to end. */
      if (body.customer?.name !== r.name) {
        dead.push(`${r.name}: opens as "${body.customer?.name}"`);
        continue;
      }
      const res2 = await fetch(`${base}/${r._id}/accounting?companyId=${cid}`);
      if (res2.status !== 200) {
        dead.push(`${r.name}: accounting ${res2.status}`);
        continue;
      }
      opened += 1;
    }
    check(`all ${all.length} rows open, under their own name`,
      dead.length === 0, dead.slice(0, 6).join(" | "));
    console.log(`        ${opened} opened · ${rows.length} accounting · ${crmRows.length} sales/CRM`);

    /* ── who is NOT on it ───────────────────────────────────────────── */
    console.log("\nwho is no longer listed as a customer");
    const names = rows.map((r) => String(r.name));
    const junk = names.filter((n) => /grav (test|it dept)|grav pvt|^ray$|^soumya/i.test(n));
    check("test accounts and this company are not customers", junk.length === 0, junk.join(", "));

    const withPortal = rows.filter((r) => !r.isLedgerOnly).length;
    console.log(`        ${crmTotal} CRM records exist · ${withPortal} of the ${rows.length} ledger rows have a portal login`);
    check("a portal login is a badge on a row, never a row of its own",
      rows.every((r) => r.isLedgerOnly === !r.crmCustomerId));

    /* ── the party that was showing someone else's books ────────────── */
    console.log("\nthe mislink can no longer move money between parties");
    const linked = await db.collection("acc_ledgers")
      .find({ groupName: /sundry debtor/i, isActive: { $ne: false }, linkedCustomerId: { $ne: null } })
      .project({ name: 1, linkedCustomerId: 1 }).toArray();
    let borrowed = [];
    for (const l of linked) {
      const row = rows.find((r) => String(r.ledgerId) === String(l._id));
      const crm = await db.collection("customers").findOne({ _id: l.linkedCustomerId }, { projection: { name: 1 } });
      /* Even where the link points at a different party, the row must still be
         named and valued by its own ledger. */
      if (row && crm && row.name !== l.name) borrowed.push(`${l.name} -> ${row.name}`);
    }
    /* Nor its contact details. Reading the register from the ledger stopped a
       bad link moving MONEY; the enrichment still borrowed the wrong party's
       email until it was made to check. A wrong link should cost a blank
       field, not somebody else's address. */
    const { sameParty } = require("./services/partyLinkSafety");
    const borrowedContact = [];
    for (const l of linked) {
      const c = await db
        .collection("customers")
        .findOne({ _id: l.linkedCustomerId }, { projection: { name: 1, email: 1 } });
      if (!c?.email) continue;
      if (sameParty(l.name, c.name || c.companyName)) continue;
      const row = rows.find((r) => String(r.ledgerId) === String(l._id));
      if (row && row.email === c.email) borrowedContact.push(`${l.name} shows ${c.name}'s email`);
    }
    check("nor its contact details", borrowedContact.length === 0, borrowedContact.join(" | "));

    check(`${linked.length} linked ledgers, none took its name from the CRM row`,
      borrowed.length === 0, borrowed.join(" | "));
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
