// verifyBillMatching.js
//
// A receipt settles the invoice it is matched to — and cannot settle more.
//
// Run:  node -r dotenv/config verifyBillMatching.js
//
// WHAT THIS IS ABOUT
// A receipt records that money arrived; the allocation records WHICH invoice
// it was for. Without one the invoice stays outstanding forever — bills were
// being chased months after they had been paid. This checks the matching
// engine that fixes that: partial and full settlement, the strict caps that
// stop money being allocated twice, and unmatching.
//
// IT WRITES, AND PUTS EVERYTHING BACK. It picks a REAL receipt with money
// still unallocated, matches it, asserts, then restores that voucher's
// original `billAllocations` byte for byte — including on a crash. It creates
// nothing and deletes nothing. If the restore ever fails it says so loudly,
// with the voucher number, so it can be repaired by hand.

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Restored in the finally block and on crash. */
let restore = null;

async function putBack() {
  if (!restore) return "nothing to restore";
  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");
  const v = await Acc_Voucher.findById(restore.id);
  if (!v) return "VOUCHER GONE";
  const entry = v.ledgerEntries.id(restore.entryId) ||
    v.ledgerEntries.find((e) => String(e._id) === String(restore.entryId));
  if (!entry) return "ENTRY GONE";
  entry.billAllocations = restore.original;
  v.markModified("ledgerEntries");
  await v.save();
  return "restored";
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");
  const bm = require("./services/billMatching.service");
  const openItems = require("./services/openItems.service");

  /* ── the pure rules, no database ─────────────────────────────────── */
  console.log("the shape of a match");
  const fake = {
    _id: new mongoose.Types.ObjectId(),
    voucherType: "receipt",
    status: "posted",
    companyId: new mongoose.Types.ObjectId(),
    ledgerEntries: [
      { _id: new mongoose.Types.ObjectId(), ledgerName: "Bank", type: "Dr", amount: 1000 },
      { _id: new mongoose.Types.ObjectId(), ledgerName: "A Customer", type: "Cr", amount: 1000, isPartyLedger: true, billAllocations: [] },
    ],
  };
  const st0 = bm.matchStateOf(fake);
  check("an unallocated receipt reports its whole value as unallocated",
    st0.matchable && st0.total === 1000 && st0.allocated === 0 && st0.unallocated === 1000 && !st0.fullyMatched);
  check("the party line is the Cr side of a receipt", st0.partyLedgerName === "A Customer");

  const payment = { ...fake, voucherType: "payment", ledgerEntries: [
    { _id: new mongoose.Types.ObjectId(), ledgerName: "A Supplier", type: "Dr", amount: 500, isPartyLedger: true, billAllocations: [] },
    { _id: new mongoose.Types.ObjectId(), ledgerName: "Bank", type: "Cr", amount: 500 },
  ] };
  check("and the Dr side of a payment", bm.matchStateOf(payment).partyLedgerName === "A Supplier");

  check("a sales voucher is refused outright", (() => {
    try { bm.assertMatchable({ voucherType: "sales", status: "posted" }); return false; }
    catch (e) { return e.status === 400 && /Only receipts and payments/.test(e.message); }
  })());
  check("so is a cancelled receipt", (() => {
    try { bm.assertMatchable({ voucherType: "receipt", status: "cancelled" }); return false; }
    catch (e) { return e.status === 400; }
  })());

  /* ── a real receipt with money left to allocate ──────────────────── */
  console.log("\nfinding a real receipt with money still unallocated");
  const candidates = await Acc_Voucher.find({
    voucherType: "receipt",
    status: { $nin: ["cancelled", "void"] },
  }).sort({ voucherDate: -1 }).limit(400);

  let subject = null, openBills = [];
  for (const v of candidates) {
    const st = bm.matchStateOf(v);
    if (!st.matchable || st.unallocated <= 1) continue;
    const bills = await bm.openBillsForVoucher(v, { excludeVoucherId: v._id });
    if (bills.length) { subject = v; openBills = bills; break; }
  }

  check("found a receipt with unallocated money AND open bills for its party", Boolean(subject),
    subject ? "" : "none in the latest 400 receipts — nothing to exercise against");
  if (!subject) {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }

  const entry = bm.findPartyEntry(subject);
  restore = {
    id: subject._id,
    entryId: entry._id,
    original: JSON.parse(JSON.stringify(entry.billAllocations || [])),
  };

  const before = bm.matchStateOf(subject);
  const bill = openBills[0];
  console.log(`  subject: ${subject.voucherNumber} (${subject.partyLedgerName || before.partyLedgerName})`);
  console.log(`     total ₹${before.total}  allocated ₹${before.allocated}  unallocated ₹${before.unallocated}`);
  console.log(`  oldest open bill: "${bill.billName}" outstanding ₹${bill.outstanding}`);

  /* ── PARTIAL ─────────────────────────────────────────────────────── */
  console.log("\na partial match settles part of the bill and no more");
  const part = money(Math.min(before.unallocated, bill.outstanding) / 2);
  check("there is a sensible partial amount to test with", part > 0, String(part));

  const afterPartial = await bm.applyAllocations(subject, [{ billName: bill.billName, amount: part }]);
  await subject.save();
  check("the receipt now reports that amount as allocated", afterPartial.allocated === part,
    `${afterPartial.allocated} vs ${part}`);
  check("and the rest as still unallocated", afterPartial.unallocated === money(before.total - part));
  check("it is not marked fully matched", afterPartial.fullyMatched === false);

  const reread = await Acc_Voucher.findById(subject._id);
  const billsNow = await bm.openBillsForVoucher(reread, {});
  const sameBill = billsNow.find((b) => b.billName === bill.billName);
  check("the bill's outstanding went DOWN by exactly that amount, in the reports' own numbers",
    sameBill ? Math.abs(sameBill.outstanding - money(bill.outstanding - part)) < 0.02
             : Math.abs(bill.outstanding - part) < 1,
    sameBill ? `${bill.outstanding} → ${sameBill.outstanding}` : "bill fully settled and dropped out");

  /* ── THE STRICT CAPS ─────────────────────────────────────────────── */
  console.log("\nthe caps that stop money being allocated twice");
  const overVoucher = await (async () => {
    try { await bm.applyAllocations(reread, [{ billName: bill.billName, amount: money(before.total + 1000) }]); return null; }
    catch (e) { return e; }
  })();
  check("allocating more than the receipt is worth is refused",
    Boolean(overVoucher) && overVoucher.status === 400 && /more than this receipt/.test(overVoucher.message),
    overVoucher?.message);

  /* The two caps have to be tested on different bills. Overshooting a bill
     BIGGER than the receipt trips the voucher cap first — both rules are
     doing their job, but only the first one is observable. So rule 2 needs a
     bill small enough that the overshoot still fits inside the receipt. */
  const smallBill = openBills.find((b) => b.outstanding < before.total - 1);
  if (smallBill) {
    const overBill = await (async () => {
      try {
        await bm.applyAllocations(reread, [
          { billName: smallBill.billName, amount: money(smallBill.outstanding + 1) },
        ]);
        return null;
      } catch (e) { return e; }
    })();
    check("allocating more than the BILL has outstanding is refused",
      Boolean(overBill) && overBill.status === 400 && /outstanding/.test(overBill.message),
      overBill?.message);
    check("...and exactly its outstanding is ACCEPTED — the cap is a limit, not an obstacle",
      await (async () => {
        try {
          await bm.applyAllocations(reread, [
            { billName: smallBill.billName, amount: smallBill.outstanding },
          ]);
          return true;
        } catch { return false; }
      })());
  } else {
    check("(no bill smaller than this receipt — the per-bill cap is exercised by the settled-bill checks below)", true);
  }

  const foreign = await (async () => {
    try { await bm.applyAllocations(reread, [{ billName: "NOT-A-REAL-BILL-9999", amount: 1 }]); return null; }
    catch (e) { return e; }
  })();
  check("a bill that is not this party's open item is refused",
    Boolean(foreign) && foreign.status === 400 && /not an open bill/.test(foreign.message),
    foreign?.message);

  check("a zero allocation is refused rather than silently dropped", await (async () => {
    try { await bm.applyAllocations(reread, [{ billName: bill.billName, amount: 0 }]); return false; }
    catch (e) { return /more than zero/.test(e.message); }
  })());

  console.log("\nan already-settled bill cannot be matched again");
  /* Settle it to the last paise, then try to add one rupee more. */
  const fullAmt = money(Math.min(before.total, bill.outstanding));
  await bm.applyAllocations(reread, [{ billName: bill.billName, amount: fullAmt }]);
  await reread.save();
  const settled = await Acc_Voucher.findById(subject._id);
  const stillOpen = await bm.openBillsForVoucher(settled, {});
  const gone = !stillOpen.find((b) => b.billName === bill.billName);
  check("once settled in full the bill is no longer offered for matching", gone || fullAmt < bill.outstanding - 0.02,
    gone ? "" : "still listed");

  const second = await Acc_Voucher.findOne({
    _id: { $ne: subject._id },
    voucherType: "receipt",
    partyLedgerId: subject.partyLedgerId,
    status: { $nin: ["cancelled", "void"] },
  });
  if (second && gone) {
    const err = await (async () => {
      try { await bm.applyAllocations(second, [{ billName: bill.billName, amount: 1 }]); return null; }
      catch (e) { return e; }
    })();
    check("and ANOTHER receipt cannot match it either — the strict rule",
      Boolean(err) && /not an open bill/.test(err.message), err?.message);
  } else {
    check("(no second receipt for this party to test cross-voucher strictness with)", true);
  }

  /* ── UNMATCH ─────────────────────────────────────────────────────── */
  console.log("\nunmatching puts the bill back");
  const cleared = await bm.clearAllocations(settled);
  await settled.save();
  check("the receipt reports nothing allocated", cleared.allocated === 0 && cleared.allocations.length === 0);
  check("and its whole value unallocated again", cleared.unallocated === before.total);

  const reopened = await bm.openBillsForVoucher(await Acc_Voucher.findById(subject._id), {});
  const back = reopened.find((b) => b.billName === bill.billName);
  check("the bill is outstanding again, at its original figure",
    Boolean(back) && Math.abs(back.outstanding - bill.outstanding) < 0.02,
    back ? `${back.outstanding} vs ${bill.outstanding}` : "not listed");

  /* ── an invoice that never established a bill ────────────────────── */
  // 81 of 154 sales invoices carry no `new_ref`, because the sales form only
  // started writing one part-way through. The fold cannot see those, so the
  // matching screen used to tell a customer with a real unpaid invoice that
  // they owed nothing. This is that case, end to end.
  console.log("\nan invoice with no bill reference is still matchable");
  const unbilled = await (async () => {
    const recs = await Acc_Voucher.find({
      voucherType: "receipt",
      status: { $nin: ["cancelled", "void"] },
      partyLedgerId: { $ne: null },
    }).limit(400);
    for (const r of recs) {
      const st = bm.matchStateOf(r);
      if (!st.matchable || st.unallocated <= 1) continue;
      const folded = await openItems.billsByLedger(r.companyId, [st.partyLedgerId]);
      const only = await bm.unbilledInvoicesForParty(r, folded);
      if (only.length) return { receipt: r, bills: only, state: st };
    }
    return null;
  })();

  check("found a receipt whose party has an invoice carrying no bill reference",
    Boolean(unbilled), unbilled ? "" : "none left — they may all be referenced now");

  if (unbilled) {
    const inv = unbilled.bills[0];
    console.log(`  ${unbilled.receipt.voucherNumber} → invoice "${inv.billName}" ₹${inv.outstanding} (no new_ref)`);
    const offered = await bm.openBillsForVoucher(unbilled.receipt, { excludeVoucherId: unbilled.receipt._id });
    check("it is OFFERED for matching rather than the screen saying 'nothing outstanding'",
      offered.some((b) => b.billName === inv.billName),
      `offered: ${offered.map((b) => b.billName).join(", ") || "(none)"}`);

    /* Snapshot the invoice so this test restores it too. */
    const invoiceDoc = await Acc_Voucher.findById(inv.sourceVoucherId);
    const invParty = (invoiceDoc.ledgerEntries || []).find(
      (e) => e.isPartyLedger && e.type === "Dr",
    ) || (invoiceDoc.ledgerEntries || []).find((e) => e.type === "Dr");
    const invBefore = JSON.parse(JSON.stringify(invParty?.billAllocations || []));
    const rcptEntry = bm.findPartyEntry(unbilled.receipt);
    const rcptBefore = JSON.parse(JSON.stringify(rcptEntry.billAllocations || []));

    try {
      const amt = money(Math.min(unbilled.state.unallocated, inv.outstanding) / 2);
      await bm.applyAllocations(unbilled.receipt, [{ billName: inv.billName, amount: amt }]);
      await unbilled.receipt.save();

      const invAfter = await Acc_Voucher.findById(inv.sourceVoucherId).lean();
      const afterParty = (invAfter.ledgerEntries || []).find(
        (e) => e.isPartyLedger && e.type === "Dr",
      ) || (invAfter.ledgerEntries || []).find((e) => e.type === "Dr");
      const newRef = (afterParty?.billAllocations || []).find(
        (a) => a.billType === "new_ref" && a.billName === inv.billName,
      );
      check("matching it WRITES the bill reference onto the invoice",
        Boolean(newRef) && Math.abs(newRef.amount - inv.originalAmount) < 0.02,
        newRef ? `new_ref ₹${newRef.amount}` : "no new_ref written");

      /* The point of writing it: the fold now reads a real remaining, not a
         negative phantom credit. */
      const foldedAfter = await openItems.billsByLedger(unbilled.receipt.companyId, [
        unbilled.state.partyLedgerId,
      ]);
      const b = [...foldedAfter.values()].find((x) => x.billName === inv.billName);
      check("and the outstanding report now shows it correctly reduced, not negative",
        b && b.remaining > 0 && Math.abs(b.remaining - (inv.originalAmount - amt)) < 1.5,
        b ? `remaining ₹${b.remaining} (expected ~₹${money(inv.originalAmount - amt)})` : "bill missing from fold");
    } finally {
      // Put both documents back.
      const rDoc = await Acc_Voucher.findById(unbilled.receipt._id);
      const rEnt = bm.findPartyEntry(rDoc);
      if (rEnt) { rEnt.billAllocations = rcptBefore; rDoc.markModified("ledgerEntries"); await rDoc.save(); }
      const iDoc = await Acc_Voucher.findById(inv.sourceVoucherId);
      const iEnt = (iDoc.ledgerEntries || []).find((e) => e.isPartyLedger && e.type === "Dr")
        || (iDoc.ledgerEntries || []).find((e) => e.type === "Dr");
      if (iEnt) { iEnt.billAllocations = invBefore; iDoc.markModified("ledgerEntries"); await iDoc.save(); }
      console.log("  restored both the receipt and the invoice");
    }
  }

  console.log("\na receipt with no real party is not offered for matching");
  const noParty = await Acc_Voucher.findOne({
    voucherType: "receipt",
    status: { $nin: ["cancelled", "void"] },
    partyLedgerId: null,
    "ledgerEntries.isPartyLedger": { $ne: true },
  }).lean();
  if (noParty) {
    const st = bm.matchStateOf(noParty);
    check("a bank-interest / loan receipt reports itself unmatchable",
      st.matchable === false && /not against a customer or supplier/.test(st.reason || ""),
      JSON.stringify(st).slice(0, 140));
  } else {
    check("(no party-less receipt in this database to check)", true);
  }

  /* ── the HTTP layer ──────────────────────────────────────────────── */
  // Mounted in-process rather than against a running server, so this runs
  // wherever the harness does. The dev-only auth bypass documented in
  // CLAUDE.md stands in for a session; it is set and unset around the test.
  console.log("\nthe routes, mounted in-process");
  const prevBypass = process.env.ACCOUNTANT_AUTH_BYPASS;
  process.env.ACCOUNTANT_AUTH_BYPASS = "true";
  let server;
  try {
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/api/accountant/vouchers", require("./routes/Accountant_Routes/Acc_vouchers"));
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/accountant/vouchers`;

    const worklist = await fetch(
      `${base}/unmatched?companyId=${subject.companyId}&voucherType=receipt&limit=50`,
    );
    const wl = await worklist.json();
    check("GET /unmatched answers 200 — it is not swallowed by the /:id route",
      worklist.status === 200 && Array.isArray(wl.vouchers), JSON.stringify(wl).slice(0, 160));
    check("and it reports how much money is settling nothing",
      wl.summary && typeof wl.summary.unallocatedTotal === "number",
      JSON.stringify(wl.summary));

    const one = await fetch(`${base}/${subject._id}/match`);
    const oneJ = await one.json();
    check("GET /:id/match returns the state and the open bills",
      one.status === 200 && oneJ.matchable === true && Array.isArray(oneJ.openBills),
      JSON.stringify(oneJ).slice(0, 160));

    const salesV = await Acc_Voucher.findOne({ voucherType: "sales" }).select("_id").lean();
    if (salesV) {
      const bad = await fetch(`${base}/${salesV._id}/match`);
      check("GET /:id/match on a SALES voucher is refused with 400", bad.status === 400,
        `got ${bad.status}`);
    }

    const post = await fetch(`${base}/${subject._id}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocations: [{ billName: bill.billName, amount: 1 }] }),
    });
    const postJ = await post.json();
    check("POST /:id/match allocates and answers with the new state",
      post.status === 200 && postJ.success === true && postJ.allocated === 1,
      JSON.stringify(postJ).slice(0, 160));

    const overPost = await fetch(`${base}/${subject._id}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocations: [{ billName: bill.billName, amount: before.total + 5000 }] }),
    });
    check("an over-allocation over HTTP is a 400 with a readable reason",
      overPost.status === 400 && /more than this receipt/.test((await overPost.json()).error || ""));

    const del = await fetch(`${base}/${subject._id}/match`, { method: "DELETE" });
    const delJ = await del.json();
    check("DELETE /:id/match unmatches it", del.status === 200 && delJ.allocated === 0,
      JSON.stringify(delJ).slice(0, 120));
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (prevBypass === undefined) delete process.env.ACCOUNTANT_AUTH_BYPASS;
    else process.env.ACCOUNTANT_AUTH_BYPASS = prevBypass;
  }

  console.log("\nnon-settlement rows are never touched");
  const withNewRef = await Acc_Voucher.findOne({
    voucherType: "sales",
    "ledgerEntries.billAllocations.billType": "new_ref",
  }).lean();
  check("an invoice still carries its own new_ref (matching only writes agst_ref)",
    Boolean(withNewRef));

  /* ── restore ─────────────────────────────────────────────────────── */
  console.log("\nrestoring the subject voucher");
  const outcome = await putBack();
  const final = await Acc_Voucher.findById(subject._id);
  const finalState = bm.matchStateOf(final);
  console.log(`  ${outcome}: allocated ₹${finalState.allocated} (was ₹${before.allocated})`);
  check("the receipt is exactly as it was found", finalState.allocated === before.allocated
    && finalState.allocations.length === before.allocations.length,
    `${JSON.stringify(finalState.allocations)} vs ${JSON.stringify(before.allocations)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try {
    console.error("restore:", await putBack());
  } catch (err) {
    console.error(`RESTORE FAILED for voucher ${restore?.id} — repair its billAllocations by hand:`, err.message);
  }
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
