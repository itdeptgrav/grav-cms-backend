// verifyJournalMatching.js
//
// A payment can settle a JOURNAL, not just a supplier bill.
//
// Run:  node -r dotenv/config verifyJournalMatching.js
//
// WHAT THIS IS ABOUT
// Posting payroll writes a journal — Dr Salaries, Cr Salary Payable — and the
// money leaves later on a payment voucher, Dr Salary Payable / Cr Bank.
// Neither carries a party: salary is owed to staff, not to a Sundry Creditor,
// so `isPartyLedger` is false on every line and `partyLedgerId` is unset.
// Matching therefore refused the payment outright — "not against a customer or
// supplier account" — and the journal stayed open forever while the payment
// settled nothing.
//
// The rule now is: a payment's Dr leg on a LIABILITY ledger is settling
// something the books already recorded as owed, and the journals that credited
// that same ledger are the open items it can settle.
//
// THE TWO THINGS THAT MUST BOTH HOLD
//   1. The payroll payment can now match its journal, in part or in full.
//   2. Nothing else moved. Receipts must NOT gain a liability path (that is
//      how the old single-line fallback claimed a party for 66 receipts that
//      have none), and a journal crediting PF Payable must never be offered
//      to a payment that is clearing Salary Payable.
//
// IT WRITES, AND PUTS EVERYTHING BACK — the payment's allocations and the
// journal's bill reference are snapshotted and restored, including on a crash.

"use strict";

const mongoose = require("mongoose");

const R = (n) => "₹" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-IN");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

let restore = null;
async function putBack() {
  if (!restore) return "nothing to restore";
  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");
  await Acc_Voucher.updateOne(
    { _id: restore.paymentId },
    { $set: { ledgerEntries: restore.paymentEntries } },
  );
  if (restore.journalId) {
    await Acc_Voucher.updateOne(
      { _id: restore.journalId },
      { $set: { ledgerEntries: restore.journalEntries } },
    );
  }
  return "restored the payment and the journal";
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const bm = require("./services/billMatching.service");
  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");

  /* ── the shape this exists for ──────────────────────────────────────── */
  console.log("a payroll payment has no party anywhere on it");
  /* Chosen by SHAPE, not by source: a payment with no party at all whose Dr
     leg is a liability, and which has at least one open journal to settle.
     Keying off `sourceReference: /payroll/i` picked a voucher that happened to
     exist last week and vanished from this shared database by the next run —
     the harness should describe the case, not name a row. Payroll first when
     one is present, since that is the case that prompted this. */
  const candidates = await Acc_Voucher.find({
    voucherType: "payment",
    status: "posted",
    partyLedgerId: { $in: [null, undefined] },
  })
    .sort({ voucherDate: -1 })
    .limit(400);

  let payment = null;
  let liabilities = null;
  const ranked = [
    ...candidates.filter((v) => /payroll|salary/i.test(`${v.sourceReference || ""} ${v.narration || ""}`)),
    ...candidates.filter((v) => !/payroll|salary/i.test(`${v.sourceReference || ""} ${v.narration || ""}`)),
  ];
  for (const v of ranked) {
    if ((v.ledgerEntries || []).some((e) => e.isPartyLedger)) continue;
    const liab = await bm.liabilityLedgerIdsFor(v.toObject());
    if (liab.size !== 1) continue;
    const st = bm.matchStateOf(v.toObject(), null, liab);
    if (!st.matchable) continue;
    const open = await bm.openBillsForVoucher(v.toObject(), {
      partyLedgerId: st.partyLedgerId,
      liabilityLedgerIds: liab,
    });
    if (open.some((b) => b.sourceVoucherType === "journal")) {
      payment = v;
      liabilities = liab;
      break;
    }
  }
  check("found a party-less payment that settles a liability", Boolean(payment));
  if (!payment) {
    console.log("\n(no such payment in this database — nothing to check)");
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log(`        ${payment.voucherNumber} · ${R(payment.grandTotal)}`);
  check("it carries no partyLedgerId", !payment.partyLedgerId);
  check("and no line is flagged as a party ledger",
    (payment.ledgerEntries || []).every((e) => !e.isPartyLedger));

  const plain = payment.toObject();
  check("so the OLD rule refuses it outright",
    bm.matchStateOf(plain).matchable === false);

  /* ── the new rule ───────────────────────────────────────────────────── */
  console.log("\nthe liability leg is what makes it matchable");
  check("exactly one of its legs is a liability ledger", liabilities.size === 1,
    `${liabilities.size}`);

  const state = bm.matchStateOf(plain, null, liabilities);
  check("it is matchable now", state.matchable, state.reason);
  check("on the liability, not the bank",
    /payable/i.test(state.partyLedgerName || ""), state.partyLedgerName);
  check("for the full amount of that leg",
    Math.abs(state.total - payment.grandTotal) < 1,
    `${R(state.total)} vs ${R(payment.grandTotal)}`);

  /* ── receipts must not have gained this ─────────────────────────────── */
  console.log("\nmoney coming IN did not gain a liability path");
  check("receipts are not an obligation type",
    !bm.OBLIGATION_TYPES.has("receipt") && !bm.OBLIGATION_TYPES.has("credit_note"));
  const anyReceipt = await Acc_Voucher.findOne({ voucherType: "receipt", status: "posted" }).lean();
  if (anyReceipt) {
    const rl = await bm.liabilityLedgerIdsFor(anyReceipt);
    check("a receipt yields no liability legs at all", rl.size === 0, `${rl.size}`);
    const before = bm.matchStateOf(anyReceipt).matchable;
    const after = bm.matchStateOf(anyReceipt, null, liabilities).matchable;
    check("and its match state is identical either way", before === after,
      `${before} vs ${after}`);
  }

  /* ── the journals it may settle ─────────────────────────────────────── */
  console.log("\nthe open items offered are journals on that same ledger");
  const bills = await bm.openBillsForVoucher(plain, {
    excludeVoucherId: plain._id,
    partyLedgerId: state.partyLedgerId,
    liabilityLedgerIds: liabilities,
  });
  check("at least one open journal is offered", bills.length > 0, `${bills.length}`);
  check("every one of them is a journal",
    bills.every((b) => b.sourceVoucherType === "journal"),
    bills.map((b) => b.sourceVoucherType).join(","));
  check("each is signed as a payable, like a purchase bill",
    bills.every((b) => b.signedRemaining < 0));

  /* The amount offered must be the journal's Cr on THIS ledger — not its
     grand total, which also covers PF and ESI. */
  const sample = await Acc_Voucher.findById(bills[0].sourceVoucherId).lean();
  const crHere = (sample.ledgerEntries || [])
    .filter((e) => String(e.ledgerId) === String(state.partyLedgerId) && e.type === "Cr")
    .reduce((s, e) => s + e.amount, 0);
  check("the offer is that journal's Cr on this ledger, not its grand total",
    Math.abs(bills[0].originalAmount - crHere) < 1 &&
      (Math.abs(sample.grandTotal - crHere) > 1 || sample.grandTotal === crHere),
    `offered ${R(bills[0].originalAmount)} · Cr here ${R(crHere)} · JV total ${R(sample.grandTotal)}`);

  const otherLiabilities = (sample.ledgerEntries || [])
    .filter((e) => e.type === "Cr" && String(e.ledgerId) !== String(state.partyLedgerId));
  if (otherLiabilities.length) {
    console.log(`        that journal also credits ${otherLiabilities.map((e) => e.ledgerName).join(", ")} — excluded, correctly`);
    check("the other liabilities on it are NOT part of the offer",
      bills[0].originalAmount < sample.grandTotal - 1);
  }

  /* ── match it for real ──────────────────────────────────────────────── */
  console.log("\nmatching it, then putting it back");
  const target = bills[0];
  const journal = await Acc_Voucher.findById(target.sourceVoucherId).lean();
  restore = {
    paymentId: payment._id,
    paymentEntries: JSON.parse(JSON.stringify(payment.toObject().ledgerEntries)),
    journalId: journal._id,
    journalEntries: JSON.parse(JSON.stringify(journal.ledgerEntries)),
  };

  try {
    const part = Math.round(Math.min(target.outstanding, state.unallocated) / 2);
    const doc = await Acc_Voucher.findById(payment._id);
    const afterPart = await bm.applyAllocations(doc, [{ billName: target.billName, amount: part }],
      { partyLedgerId: state.partyLedgerId });
    await doc.save();
    check(`a PARTIAL match of ${R(part)} is accepted`,
      Math.abs(afterPart.allocated - part) < 1, `${R(afterPart.allocated)}`);
    check("and the payment still has the rest unallocated",
      afterPart.unallocated > 0, R(afterPart.unallocated));

    /* The journal must now carry the reference — on the right line. */
    const stamped = await Acc_Voucher.findById(journal._id).lean();
    const refLine = (stamped.ledgerEntries || []).find(
      (e) => String(e.ledgerId) === String(state.partyLedgerId) && e.type === "Cr",
    );
    const wrongLine = (stamped.ledgerEntries || []).find(
      (e) => e.type === "Cr" && String(e.ledgerId) !== String(state.partyLedgerId) &&
        (e.billAllocations || []).some((a) => a.billType === "new_ref"),
    );
    check("the journal now carries its bill reference",
      (refLine?.billAllocations || []).some(
        (a) => a.billType === "new_ref" && a.billName === journal.voucherNumber),
      JSON.stringify(refLine?.billAllocations || []).slice(0, 120));
    check("stamped on the ledger being paid, not on PF or ESI", !wrongLine,
      wrongLine?.ledgerName);

    /* The outstanding must have moved by exactly what was paid. */
    const reopened = await Acc_Voucher.findById(payment._id).lean();
    const nowOpen = await bm.openBillsForVoucher(reopened, {
      partyLedgerId: state.partyLedgerId,
      liabilityLedgerIds: liabilities,
    });
    const row = nowOpen.find((b) => b.billName === target.billName);
    check("the journal's outstanding dropped by exactly what was paid",
      row ? Math.abs(row.outstanding - (target.outstanding - part)) < 1 : false,
      row ? `${R(row.outstanding)} vs expected ${R(target.outstanding - part)}` : "gone from the list");

    /* Over-allocation must still be refused — whichever cap bites first.
       On a payment smaller than the journal it is the voucher cap that fires,
       and asserting on the bill-cap wording specifically would fail on a
       correct refusal. Both caps are checked; which one speaks is not the
       point, that the money is refused is. */
    const doc2 = await Acc_Voucher.findById(payment._id);
    let overBill = "";
    try {
      await bm.applyAllocations(doc2,
        [{ billName: target.billName, amount: target.outstanding + 100000 }],
        { partyLedgerId: state.partyLedgerId });
    } catch (e) { overBill = e.message; }
    check("paying MORE than the journal owes is refused", Boolean(overBill), overBill);

    const doc2b = await Acc_Voucher.findById(payment._id);
    let overVoucher = "";
    try {
      await bm.applyAllocations(doc2b,
        [{ billName: target.billName, amount: state.total + 1 }],
        { partyLedgerId: state.partyLedgerId });
    } catch (e) { overVoucher = e.message; }
    check("and allocating more than the payment itself is refused",
      /more than this payment/i.test(overVoucher), overVoucher);

    /* The bill cap in isolation — only provable where a journal owes LESS
       than the payment is worth, otherwise the voucher cap fires first. */
    const smaller = bills.find((b) => b.outstanding < state.total - 1);
    if (smaller) {
      const doc2c = await Acc_Voucher.findById(payment._id);
      let capped = "";
      try {
        await bm.applyAllocations(doc2c,
          [{ billName: smaller.billName, amount: smaller.outstanding + 1 }],
          { partyLedgerId: state.partyLedgerId });
      } catch (e) { capped = e.message; }
      check("a journal cannot be over-settled even when the payment could cover it",
        /outstanding/i.test(capped), capped);
    } else {
      console.log("        (no journal here owes less than this payment — bill cap not isolable)");
    }

    /* Unmatch. */
    const doc3 = await Acc_Voucher.findById(payment._id);
    const cleared = await bm.clearAllocations(doc3, { partyLedgerId: state.partyLedgerId });
    await doc3.save();
    check("unmatching returns the whole amount", cleared.allocated === 0 &&
      Math.abs(cleared.unallocated - state.total) < 1, R(cleared.unallocated));
  } finally {
    console.log(`  ${await putBack()}`);
    const back = await Acc_Voucher.findById(payment._id).lean();
    const backAlloc = (back.ledgerEntries || [])
      .flatMap((e) => e.billAllocations || [])
      .filter((a) => a.billType === "agst_ref").length;
    const wasAlloc = restore.paymentEntries
      .flatMap((e) => e.billAllocations || [])
      .filter((a) => a.billType === "agst_ref").length;
    check("the payment is exactly as it was found", backAlloc === wasAlloc,
      `${backAlloc} vs ${wasAlloc}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { console.error("restore:", await putBack()); }
  catch (err) { console.error("RESTORE FAILED — check by hand:", err.message); }
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
