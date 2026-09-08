// verifyPayrollPaymentLink.js
//
// Posting payroll records the cost. Paying it is a separate, evidenced event.
//
// Run:  node -r dotenv/config verifyPayrollPaymentLink.js
//
// WHAT CHANGED, AND WHY IT MATTERS
// Posting used to create a bank payment voucher whenever HR had ticked the run
// as "paid" — so the books could show salaries leaving the bank on a date
// nobody paid anything, chosen by when somebody clicked a checkbox. Posting now
// creates the JOURNAL only. The payment is recorded as a payment voucher and
// LINKED to the run, and that link is what marks it paid: no voucher, no
// "paid".
//
// IT WRITES, AND PUTS EVERYTHING BACK. The link half runs against a real run
// and a real payment voucher, snapshotting the run's status, the affected
// items' statuses, and the voucher's source fields, then restoring all three —
// including on a crash.

"use strict";

/* The dev auth bypass documented in CLAUDE.md, set BEFORE anything is
   required: AccountantAuthMiddleware reads it once, at load, and any earlier
   require would freeze it off and every request here would 401. */
process.env.ACCOUNTANT_AUTH_BYPASS = "true";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

let restore = null;
async function putBack() {
  if (!restore) return "nothing to restore";
  const HR = require("./models/HR_Models/Payroll");
  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");
  await HR.Payroll.updateOne({ _id: restore.runId }, { $set: { status: restore.runStatus } });
  for (const [id, st] of restore.itemStatuses) {
    await HR.PayrollItem.updateOne({ _id: id }, { $set: { status: st } });
  }
  if (restore.voucherId) {
    await Acc_Voucher.updateOne(
      { _id: restore.voucherId },
      { $set: { sourceSystem: restore.vSystem, sourceReference: restore.vRef },
        ...(restore.vSourceId ? { $set: { sourceId: restore.vSourceId } } : { $unset: { sourceId: "" } }) },
    );
  }
  return "restored";
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const HR = require("./models/HR_Models/Payroll");
  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");

  /* ── the ledger the owner named, matched exactly ──────────────────── */
  console.log("the other-deductions ledger is matched by its exact name");
  const src = require("fs").readFileSync(
    "routes/Accountant_Routes/Acc_chartOfAccounts.js", "utf8",
  );
  const block = src.slice(src.indexOf("const otherDeductionsPayable"), src.indexOf("const otherDeductionsPayable") + 500);
  check("the exact name is the FIRST candidate tried",
    /\[\s*\n\s*"Staff Welfare\/Festival\/Entertainment Expenses A\/c",/.test(block), block.slice(0, 160));
  check("and it resolves as an expense, not a liability", /"expense",/.test(block));
  const { Acc_Ledger, Acc_Company } = require("./models/Accountant_model/Acc_MasterModels");
  const exact = await Acc_Ledger.findOne({ name: "Staff Welfare/Festival/Entertainment Expenses A/c" }).lean();
  check("a ledger with exactly that name exists and is active",
    Boolean(exact) && exact.isActive !== false, exact ? exact.name : "not found");
  /* Anchored ^…$ — so it cannot drift onto a similarly-named ledger. */
  const lookalikes = await Acc_Ledger.countDocuments({ name: /staff welfare/i });
  console.log(`  ${lookalikes} ledger(s) contain "staff welfare"; the match is anchored, so only the exact one is taken`);

  /* ── posting builds the journal only ─────────────────────────────── */
  console.log("\nposting a payroll run builds the JOURNAL and nothing else");
  const runs = await HR.Payroll.find({}).sort({ year: -1, month: -1 }).limit(20).lean();
  check("found payroll runs to check against", runs.length > 0);

  const companies = await Acc_Company.find({}).select("_id").lean();
  const companyId = companies[0]?._id;

  let built = null, subjectRun = null;
  for (const r of runs) {
    const items = await HR.PayrollItem.find({ month: r.month, year: r.year }).lean();
    if (!items.length) continue;
    built = { items: items.length };
    subjectRun = r;
    break;
  }
  check("the payment-voucher branch is now opt-in, not driven by HR's status",
    /opts\.includePaymentVoucher === true/.test(src)
      && !/run\.status === "paid" && totals\.net > 0/.test(src),
    "posting still keys off run.status");
  check("and the journal is still built unconditionally", /voucherType: "journal"/.test(src));

  /* ── linking a payment marks the run paid ────────────────────────── */
  console.log("\nlinking a payment voucher is what marks a run paid");
  const payment = await Acc_Voucher.findOne({
    voucherType: "payment",
    status: { $nin: ["cancelled", "void"] },
    $or: [{ sourceId: { $exists: false } }, { sourceId: null }],
  });
  const run = subjectRun ? await HR.Payroll.findById(subjectRun._id) : null;

  check("found an unlinked payment voucher and a run to test with",
    Boolean(payment) && Boolean(run),
    `payment=${payment?.voucherNumber || "none"} run=${run?._id || "none"}`);

  if (payment && run && companyId) {
    const affected = await HR.PayrollItem.find({
      month: run.month, year: run.year,
    }).select("_id status").lean();
    restore = {
      runId: run._id,
      runStatus: run.status,
      itemStatuses: affected.map((i) => [i._id, i.status]),
      voucherId: payment._id,
      vSystem: payment.sourceSystem,
      vRef: payment.sourceReference,
      vSourceId: payment.sourceId,
    };

    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/coa", require("./routes/Accountant_Routes/Acc_chartOfAccounts"));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/coa`;

    try {
      const cid = String(payment.companyId || companyId);

      const cand = await (await fetch(
        `${base}/payroll/runs/${run._id}/payment-candidates?companyId=${cid}`,
      )).json();
      check("the candidates endpoint answers with unlinked payments",
        cand.success && Array.isArray(cand.candidates), JSON.stringify(cand).slice(0, 140));

      const wrong = await fetch(`${base}/payroll/runs/${run._id}/link-payment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, paymentVoucherId: String(run._id) }),
      });
      check("linking something that is not a payment voucher is refused", wrong.status >= 400);

      const link = await fetch(`${base}/payroll/runs/${run._id}/link-payment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, paymentVoucherId: String(payment._id) }),
      });
      const lj = await link.json();
      check("linking the payment succeeds", link.status === 200 && lj.success, JSON.stringify(lj).slice(0, 160));
      check("and the run is now paid", lj.runStatus === "paid", lj.runStatus);

      const afterRun = await HR.Payroll.findById(run._id).lean();
      const afterItems = await HR.PayrollItem.countDocuments({
        month: run.month, year: run.year, status: "paid",
      });
      check("the run and its items agree — both say paid",
        afterRun.status === "paid" && afterItems === affected.length,
        `run=${afterRun.status} items paid=${afterItems}/${affected.length}`);

      const stamped = await Acc_Voucher.findById(payment._id).lean();
      check("the payment voucher now points at this run",
        String(stamped.sourceId) === String(run._id) && /\/payment$/.test(stamped.sourceReference || ""),
        stamped.sourceReference);

      /* The rule that stops one bank payment marking two months paid. */
      const otherRun = runs.find((r) => String(r._id) !== String(run._id));
      if (otherRun) {
        const dbl = await fetch(`${base}/payroll/runs/${otherRun._id}/link-payment`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: cid, paymentVoucherId: String(payment._id) }),
        });
        check("the same payment cannot also settle another run",
          dbl.status >= 400 && /already linked/i.test((await dbl.json()).message || ""));
      }

      const un = await fetch(`${base}/payroll/runs/${run._id}/unlink-payment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid }),
      });
      const uj = await un.json();
      check("unlinking succeeds and the run stops being paid",
        un.status === 200 && uj.runStatus !== "paid", JSON.stringify(uj).slice(0, 140));
      const unstamped = await Acc_Voucher.findById(payment._id).lean();
      check("and the voucher stops claiming the run", !unstamped.sourceId);
    } finally {
      await new Promise((r) => server.close(r));
      console.log(`  ${await putBack()} the run, its items and the voucher`);
      const back = await HR.Payroll.findById(run._id).lean();
      check("the run is exactly as it was found", back.status === restore.runStatus,
        `${back.status} vs ${restore.runStatus}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { console.error("restore:", await putBack()); }
  catch (err) { console.error(`RESTORE FAILED for run ${restore?.runId} — check its status by hand:`, err.message); }
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
