// auditAccounting.js
//
// Does this set of books actually hold together?
//
// Run:  node -r dotenv/config auditAccounting.js          (READ-ONLY)
//
// Not a test of one feature — a sweep of the invariants that must be true of
// any set of books, run against every posted voucher in the database. Each
// section says what it checks and, when it finds something, names the exact
// vouchers so it can be gone and looked at rather than argued about.
//
// Nothing is written. Nothing is fixed. This reports.

"use strict";

const mongoose = require("mongoose");

const R = (n) => "₹" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-IN");
const findings = [];
let ok = 0;

function good(msg) { ok += 1; console.log(`  ok    ${msg}`); }
function bad(sev, title, detail, sample = []) {
  findings.push({ sev, title, detail, sample });
  console.log(`  ${sev === "high" ? "!!" : sev === "med" ? " !" : " ~"}    ${title} — ${detail}`);
  for (const s of sample.slice(0, 5)) console.log(`          ${s}`);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);
  const db = mongoose.connection.db;
  const V = db.collection("acc_vouchers");
  const L = db.collection("acc_ledgers");

  const posted = await V.find({ status: "posted" }).toArray();
  console.log(`auditing ${posted.length} posted vouchers, ${await L.countDocuments()} ledgers\n`);

  /* ── 1. every voucher balances ───────────────────────────────────── */
  console.log("1. double entry — every voucher balances");
  const unbalanced = [];
  for (const v of posted) {
    const dr = (v.ledgerEntries || []).filter((e) => e.type === "Dr").reduce((s, e) => s + (e.amount || 0), 0);
    const cr = (v.ledgerEntries || []).filter((e) => e.type === "Cr").reduce((s, e) => s + (e.amount || 0), 0);
    if (Math.abs(dr - cr) > 0.5) unbalanced.push(`${v.voucherNumber} Dr ${R(dr)} vs Cr ${R(cr)}`);
  }
  unbalanced.length
    ? bad("high", "vouchers that do not balance", `${unbalanced.length} of ${posted.length}`, unbalanced)
    : good(`all ${posted.length} posted vouchers balance`);

  /* ── 2. stored ledger balances match the vouchers ────────────────── */
  console.log("\n2. each ledger's stored balance equals its postings");
  const moved = new Map();
  for (const v of posted) {
    for (const e of v.ledgerEntries || []) {
      if (!e.ledgerId) continue;
      const k = String(e.ledgerId);
      moved.set(k, (moved.get(k) || 0) + (e.type === "Dr" ? 1 : -1) * (e.amount || 0));
    }
  }
  const ledgers = await L.find({}).project({ name: 1, openingBalance: 1, openingBalanceType: 1, currentBalance: 1 }).toArray();
  const drift = [];
  for (const l of ledgers) {
    const opening = (l.openingBalance || 0) * (l.openingBalanceType === "Cr" ? -1 : 1);
    const expected = opening + (moved.get(String(l._id)) || 0);
    const stored = l.currentBalance || 0;
    if (Math.abs(expected - stored) > 1) {
      drift.push(`${l.name}: stored ${R(stored)} vs computed ${R(expected)} (off by ${R(stored - expected)})`);
    }
  }
  drift.length
    ? bad("med", "ledgers whose stored balance has drifted", `${drift.length} of ${ledgers.length} — reports that read the stored figure will disagree with the ledger page`, drift)
    : good(`all ${ledgers.length} ledger balances agree with their postings`);

  /* ── 3. the trial balance ────────────────────────────────────────── */
  console.log("\n3. the books as a whole");
  const totalSigned = [...moved.values()].reduce((s, v) => s + v, 0);
  Math.abs(totalSigned) < 1
    ? good(`postings net to zero across every ledger (${R(totalSigned)})`)
    : bad("high", "the books do not net to zero", `out by ${R(totalSigned)}`);

  /* ── 4. bill allocations vs the voucher they sit on ──────────────── */
  console.log("\n4. bill allocations never exceed the voucher line they sit on");
  const over = [];
  for (const v of posted) {
    for (const e of v.ledgerEntries || []) {
      const alloc = (e.billAllocations || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
      if (alloc - (e.amount || 0) > 0.5) {
        over.push(`${v.voucherNumber} · ${e.ledgerName}: allocated ${R(alloc)} on a ${R(e.amount)} line`);
      }
    }
  }
  over.length
    ? bad("high", "vouchers allocating more than the line is worth", `${over.length}`, over)
    : good("no voucher allocates more than its own line");

  /* ── 5. settlements with no bill behind them ─────────────────────── */
  console.log("\n5. every settlement has an original bill behind it");
  const bills = new Map(); // ledger||name -> {orig, settle, vouchers}
  for (const v of posted) {
    for (const e of v.ledgerEntries || []) {
      for (const a of e.billAllocations || []) {
        if (!a.billName) continue;
        const k = `${String(e.ledgerId)}||${a.billName}`;
        if (!bills.has(k)) bills.set(k, { name: a.billName, orig: 0, settle: 0, vouchers: new Set() });
        const b = bills.get(k);
        if (a.billType === "new_ref") b.orig += a.amount || 0;
        else if (a.billType === "agst_ref") b.settle += a.amount || 0;
        b.vouchers.add(v.voucherNumber);
      }
    }
  }
  const orphans = [...bills.values()].filter((b) => b.settle > 0.5 && b.orig < 0.5);
  orphans.length
    ? bad("high", "settlements against a bill that was never raised",
        `${orphans.length} — these read as a credit the customer never had`,
        orphans.map((b) => `"${b.name}" settled ${R(b.settle)} with no original · ${[...b.vouchers].join(", ")}`))
    : good("every settlement has an original bill behind it");

  const overpaid = [...bills.values()].filter((b) => b.orig > 0.5 && b.settle - b.orig > 1);
  overpaid.length
    ? bad("med", "bills settled for more than they were raised for", `${overpaid.length}`,
        overpaid.map((b) => `"${b.name}" raised ${R(b.orig)}, settled ${R(b.settle)}`))
    : good("no bill is settled for more than it was raised for");

  /* ── 6. the phantom bill name ────────────────────────────────────── */
  console.log("\n6. 'on account' money does not masquerade as a bill");
  const phantom = [...bills.values()].filter((b) => /^on account$/i.test(b.name));
  phantom.length
    ? bad("med", "allocations literally named \"On Account\"",
        `${phantom.length} — the fold groups by name, so these accumulate into a bill nobody raised`,
        phantom.map((b) => `${R(b.settle || b.orig)} across ${[...b.vouchers].join(", ")}`))
    : good("no allocation is named \"On Account\"");

  /* ── 7. receipts and payments that settle nothing ────────────────── */
  console.log("\n7. money that settles nothing");
  const bm = require("./services/billMatching.service");
  let unmatchedCount = 0, unmatchedTotal = 0, notParty = 0, multiParty = 0;
  const multiSamples = [];
  for (const v of posted) {
    if (!["receipt", "payment"].includes(v.voucherType)) continue;
    const st = bm.matchStateOf(v);
    if (!st.matchable) {
      notParty += 1;
      /* Is it unmatchable because it has SEVERAL party legs? That is a real
         receipt shape (one cheque settling two customers) and the matching
         screen cannot currently take it. */
      const wantSide = v.voucherType === "receipt" ? "Cr" : "Dr";
      /* PARTY legs, not merely legs. A receipt crediting "Bank Charges" and
         "Freight" has two lines on that side and no party at all — counting
         those as multi-party made this check cry wolf about 20 vouchers when
         two were real. */
      const legs = (v.ledgerEntries || []).filter(
        (e) => e.type === wantSide &&
          (e.isPartyLedger === true || /debtor|creditor/i.test(e.groupName || "")),
      );
      if (legs.length > 1) {
        multiParty += 1;
        if (multiSamples.length < 5) {
          multiSamples.push(`${v.voucherNumber} ${R(v.grandTotal)} → ${legs.map((l) => l.ledgerName).join(" + ")}`);
        }
      }
      continue;
    }
    if (!st.fullyMatched) { unmatchedCount += 1; unmatchedTotal += st.unallocated; }
  }
  console.log(`  ${unmatchedCount} receipts/payments still carry unallocated money, ${R(unmatchedTotal)} in total`);
  console.log(`  ${notParty} are not matchable at all (no single party line)`);
  multiParty
    ? bad("high", "multi-party receipts cannot be matched",
        `${multiParty} vouchers settle SEVERAL parties in one entry and the matching screen skips them entirely`,
        multiSamples)
    : good("no multi-party receipts are being skipped");

  /* ── 8. what the register shows vs what the voucher says ─────────── */
  console.log("\n8. the register's From -> To agrees with the voucher");
  const wrongLegs = [];
  for (const v of posted) {
    if (v.voucherType !== "receipt") continue;
    const drs = (v.ledgerEntries || []).filter((e) => e.type === "Dr");
    const crs = (v.ledgerEntries || []).filter((e) => e.type === "Cr");
    const from = v.partyLedgerName || crs[0]?.ledgerName || null;
    const to = drs.sort((a, b) => b.amount - a.amount)[0]?.ledgerName || null;
    if (from && to && from === to && crs.length && drs.length) {
      wrongLegs.push(`${v.voucherNumber}: shows "${from} -> ${to}" but credits ${crs.map((c) => c.ledgerName).join(" + ")}`);
    }
  }
  wrongLegs.length
    ? bad("med", "receipts whose register line reads bank -> bank",
        `${wrongLegs.length} — the same ledger on both sides tells the reader nothing`, wrongLegs)
    : good("no receipt shows the same ledger on both sides");

  /* ── 8b. a credit note is never reported as money received ───────── */
  console.log("\n8b. invoices closed by a credit note are not called 'paid'");
  const invStatusSrc = require("fs").readFileSync(
    "routes/Accountant_Routes/Acc_invoices.js", "utf8",
  );
  /* An invoice reaches zero either because the customer paid or because a
     credit note reversed it. Reporting the second as "paid" states that money
     arrived when none did — wrong on screen, worse in front of an auditor. */
  (/paymentStatus = "credited"/.test(invStatusSrc) &&
   /paymentStatus = "settled"/.test(invStatusSrc))
    ? good("the invoice register tells 'paid' and 'credited' apart")
    : bad("high", "credit notes are being reported as payments",
        "an invoice closed by a credit note shows as Paid with no money received");

  /* The payables twin: a bill reversed by a debit note is not "unpaid with a
     Pay button", it is closed. Both registers must name the voucher type that
     closed the document rather than reducing everything to paid/unpaid. */
  const vouchSrc = require("fs").readFileSync(
    "routes/Accountant_Routes/Acc_vouchers.js", "utf8",
  );
  /closedBy = paid && debited > 0/.test(vouchSrc) && /fullyDebited/.test(vouchSrc)
    ? good("a purchase bill reversed by a debit note counts as closed, and says so")
    : bad("high", "debit notes do not close a purchase bill",
        "the register would still offer 'Pay' on a bill that has been reversed");

  /closedBy:/.test(invStatusSrc)
    ? good("both registers name the voucher type that closed the document")
    : bad("med", "the closing voucher type is not reported",
        "a status of 'closed' that cannot say what closed it");

  /* ── 8c. customers point at their own ledger ─────────────────────── */
  console.log("\n8c. every customer is linked to its own ledger");
  /* A customer page reads its figures from the ledger it is linked to. Link
     it to the wrong one and the page shows ANOTHER party's invoices,
     receipts and balance — under this customer's name, with no sign that
     anything is wrong. Names are compared on their distinctive words: a
     shared word means it is plausibly the same party, none at all means
     somebody is reading somebody else's books. */
  const stop = new Set(["the", "and", "ltd", "pvt", "limited", "mayfair", "hotels", "resorts", "resort", "the"]);
  const words = (t) =>
    String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w));

  const linked = await L.find({ linkedCustomerId: { $ne: null } })
    .project({ name: 1, linkedCustomerId: 1 }).toArray();
  const custCol = db.collection("customers");
  const mislinked = [];
  for (const l of linked) {
    const c = await custCol.findOne({ _id: l.linkedCustomerId }, { projection: { name: 1, companyName: 1 } });
    if (!c) { mislinked.push(`"${l.name}" → a customer row that no longer exists`); continue; }
    const cn = c.name || c.companyName || "";
    const a = new Set(words(l.name));
    if (!words(cn).some((w) => a.has(w))) {
      mislinked.push(`ledger "${l.name}" → customer "${cn}"`);
    }
  }
  mislinked.length
    ? bad("high", "customers linked to another party's ledger",
        `${mislinked.length} of ${linked.length} — that customer page shows somebody else's invoices and balance`,
        mislinked)
    : good(`all ${linked.length} customer-to-ledger links point at the same party`);

  /* The subtler half. A link can point at the right NAME and still be wrong,
     because this database holds two ledgers for the same party: one the CRM
     created (linked, and empty) and one Tally imported (unlinked, and holding
     every invoice). The customer page reads the linked one, so it reports a
     party with real trade as having done nothing. Silence here looks like a
     quiet customer; it is actually a customer whose books are somewhere else. */
  const partyCounts = new Map();
  for (const r of await V.aggregate([
    { $match: { status: "posted", partyLedgerId: { $ne: null } } },
    { $group: { _id: "$partyLedgerId", n: { $sum: 1 } } },
  ]).toArray()) partyCounts.set(String(r._id), r.n);

  const allLedgers = await L.find({}).project({ name: 1, linkedCustomerId: 1 }).toArray();
  const emptyLinks = [];
  for (const l of allLedgers) {
    if (!l.linkedCustomerId) continue;
    if ((partyCounts.get(String(l._id)) || 0) > 0) continue;
    const w = new Set(words(l.name));
    const rivals = allLedgers.filter(
      (o) => String(o._id) !== String(l._id) && !o.linkedCustomerId &&
             (partyCounts.get(String(o._id)) || 0) > 0 &&
             words(o.name).filter((x) => w.has(x)).length >= 2,
    );
    if (rivals.length) {
      emptyLinks.push(`"${l.name}" is empty; the trade is on ` +
        rivals.map((r) => `"${r.name}" (${partyCounts.get(String(r._id))})`).join(", "));
    }
  }
  emptyLinks.length
    ? bad("high", "customers reading an empty duplicate of their own ledger",
        `${emptyLinks.length} — the page shows no activity while a namesake ledger holds every voucher`,
        emptyLinks)
    : good("no customer is linked to an empty duplicate of its own ledger");

  /* ── 9. PO -> bill -> payment ────────────────────────────────────── */
  console.log("\n9. purchase orders, bills and the payments against them");
  const POs = db.collection("acc_purchaseorders");
  const poCount = await POs.countDocuments().catch(() => 0);
  if (poCount) {
    const billsWithPO = await V.countDocuments({ voucherType: "purchase", purchaseOrderId: { $ne: null } });
    const paymentsWithPO = await V.countDocuments({ voucherType: "payment", purchaseOrderId: { $ne: null } });
    console.log(`  ${poCount} purchase orders · ${billsWithPO} bills linked to one · ${paymentsWithPO} payments linked`);
    const orphanPay = await V.find({
      voucherType: "payment", purchaseOrderId: { $ne: null },
    }).project({ voucherNumber: 1, purchaseOrderId: 1 }).toArray();
    const poIds = new Set((await POs.find({}).project({ _id: 1 }).toArray()).map((p) => String(p._id)));
    const dangling = orphanPay.filter((p) => !poIds.has(String(p.purchaseOrderId)));
    dangling.length
      ? bad("med", "payments pointing at a purchase order that no longer exists", `${dangling.length}`,
          dangling.map((d) => d.voucherNumber))
      : good("every PO link points at a real purchase order");
  } else {
    good("(no purchase orders in this database to check)");
  }

  /* ── 10. payroll ─────────────────────────────────────────────────── */
  console.log("\n10. payroll postings");
  const HR = (() => { try { return require("./models/HR_Models/Payroll"); } catch { return null; } })();
  if (HR) {
    const runs = await HR.Payroll.find({}).lean();
    const jvs = await V.find({ sourceSystem: "auto_from_payroll", voucherType: "journal", status: { $ne: "cancelled" } }).toArray();
    const pays = await V.find({ sourceSystem: "auto_from_payroll", voucherType: "payment", status: { $ne: "cancelled" } }).toArray();
    const jvRuns = new Set(jvs.map((v) => String(v.sourceId)));
    const payRuns = new Set(pays.map((v) => String(v.sourceId)));
    console.log(`  ${runs.length} runs · ${jvs.length} journals posted · ${pays.length} payments linked`);
    const paidNoPayment = runs.filter((r) => r.status === "paid" && !payRuns.has(String(r._id)));
    paidNoPayment.length
      ? bad("med", "runs marked paid with no payment voucher behind them",
          `${paidNoPayment.length} — 'paid' with no evidence of money leaving`,
          paidNoPayment.map((r) => `${r.payPeriod || r.year + "-" + r.month} (${r.status})`))
      : good("every run marked paid has a payment voucher linked");
    const postedNoJv = runs.filter((r) => ["processed", "approved", "paid"].includes(r.status) && !jvRuns.has(String(r._id)));
    console.log(`  ${postedNoJv.length} processed/approved runs have not been posted to the books yet`);
  } else {
    good("(payroll models unavailable)");
  }

  /* ── summary ─────────────────────────────────────────────────────── */
  const high = findings.filter((f) => f.sev === "high").length;
  const med = findings.filter((f) => f.sev === "med").length;
  console.log(`\n${"=".repeat(66)}`);
  console.log(`${ok} checks clean · ${high} serious · ${med} worth fixing`);
  if (findings.length) {
    console.log("\nwhat to look at, worst first:");
    for (const f of findings.sort((a, b) => (a.sev === "high" ? -1 : 1))) {
      console.log(`  [${f.sev.toUpperCase()}] ${f.title}: ${f.detail}`);
    }
  }
  console.log("");
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error("\naudit crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
