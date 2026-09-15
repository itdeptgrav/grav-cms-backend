// verifyJournalEntryPosting.js
//
// A journal entry that says "posted" has to have moved something.
//
// Run:  node -r dotenv/config verifyJournalEntryPosting.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// The journal-entries module was a filing cabinet. Creating an entry wrote a
// row to `acc_journal_entries`; "posting" one set `status = "posted"` and
// saved. No voucher, no ledger entries, no effect on any report — every figure
// in the accounting module is aggregated from Acc_Voucher, and a journal entry
// never became one. An entry could read "posted", with balanced debits and
// credits against named ledgers, and change no balance anywhere.
//
// Two faults underneath it, both the same kind — the page sending the right
// data into fields that did not exist: the ledger each line hits was sent as
// `accountCode` with nowhere to land, and `companyId` was dropped on every
// create.
//
// So this does not check that a row was written. It posts an entry and then
// reads the TRIAL BALANCE to see whether the money moved, which is the thing
// that was actually broken.
//
// IT WRITES, AND PUTS EVERYTHING BACK — the entry and the voucher it creates
// are deleted again, including on a crash. Every row it makes carries a marker
// and cleanup deletes by that marker, not by ids collected during the run.

"use strict";

const mongoose = require("mongoose");

const MARKER = "AUTOMATED-CHECK-verifyJournalEntryPosting";

let pass = 0,
  fail = 0;
const check = (n, ok, d = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`);
  }
};

async function cleanUp() {
  if (mongoose.connection.readyState !== 1) return "not connected";
  const db = mongoose.connection.db;
  const entries = await db
    .collection("acc_journal_entries")
    .find({ narration: { $regex: MARKER } })
    .toArray();
  const voucherIds = entries.map((e) => e.voucherId).filter(Boolean);
  let v = 0;
  if (voucherIds.length) {
    v = (
      await db.collection("acc_vouchers").deleteMany({ _id: { $in: voucherIds } })
    ).deletedCount;
  }
  // Any voucher this run made whose entry vanished first.
  v += (
    await db
      .collection("acc_vouchers")
      .deleteMany({ sourceReference: { $regex: "^JE-" }, narration: { $regex: MARKER } })
  ).deletedCount;
  const e = (
    await db
      .collection("acc_journal_entries")
      .deleteMany({ narration: { $regex: MARKER } })
  ).deletedCount;
  const a = (
    await db
      .collection("acc_activity_logs")
      .deleteMany({ details: { $regex: MARKER } })
  ).deletedCount;
  return `removed ${e} entry(ies), ${v} voucher(s), ${a} log row(s)`;
}

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const db = mongoose.connection.db;
  const {
    Acc_JournalEntry,
  } = require("./models/Accountant_model/Acc_OperationalModels");
  const { Acc_Voucher } = require("./models/Accountant_model/Acc_VoucherModels");
  const { Acc_Ledger, Acc_Company } = require("./models/Accountant_model/Acc_MasterModels");
  const posting = require("./services/journalEntryPosting.service");

  /* ── the shape of the fix ───────────────────────────────────────────── */
  console.log("the fields the page was always sending");
  const lineSchema = Acc_JournalEntry.schema.path("lines").schema;
  check(
    "a journal line can reference a ledger",
    Boolean(lineSchema.path("ledgerId")),
    "lines carried only an account NAME, so they posted to nothing",
  );
  check(
    "an entry belongs to a company",
    Boolean(Acc_JournalEntry.schema.path("companyId")),
    "companyId was sent on every create and silently dropped",
  );
  check(
    "an entry records the voucher it became",
    Boolean(Acc_JournalEntry.schema.path("voucherId")),
  );
  check(
    "the ledger id is read from wherever the page put it",
    String(posting.lineLedgerId({ accountCode: "6a47aef8399a21db939bcee6" })) ===
      "6a47aef8399a21db939bcee6",
  );

  /* ── a company with real ledgers ────────────────────────────────────── */
  const company = await Acc_Company.findOne({}).select("_id name").lean();
  check("found a company", Boolean(company), company ? String(company._id) : "none");
  if (!company) {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }

  const ledgers = await Acc_Ledger.find({ companyId: company._id, isActive: true })
    .select("_id name groupName")
    .limit(2)
    .lean();
  check("and two ledgers to move money between", ledgers.length === 2);
  if (ledgers.length < 2) {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    await cleanUp();
    await mongoose.disconnect();
    process.exit(1);
  }
  const [DR, CR] = ledgers;
  const AMOUNT = 12345.67;
  const ON = "2026-03-31";
  console.log(`\nDr ${DR.name}  /  Cr ${CR.name}   ₹${AMOUNT}`);

  /* The question this file exists to answer, asked the way a report asks it:
     what does the trial balance say this ledger's totals are? */
  const trialTotalsFor = async (ledgerId) => {
    const agg = await Acc_Voucher.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(String(company._id)),
          status: "posted",
        },
      },
      { $unwind: "$ledgerEntries" },
      {
        $match: {
          "ledgerEntries.ledgerId": new mongoose.Types.ObjectId(String(ledgerId)),
        },
      },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          debit: {
            $sum: {
              $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0],
            },
          },
          credit: {
            $sum: {
              $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0],
            },
          },
        },
      },
    ]);
    return agg[0] || { debit: 0, credit: 0 };
  };

  try {
    await cleanUp();

    const before = {
      dr: await trialTotalsFor(DR._id),
      cr: await trialTotalsFor(CR._id),
    };
    console.log(
      `  before — ${DR.name}: Dr ${before.dr.debit.toFixed(2)} · ${CR.name}: Cr ${before.cr.credit.toFixed(2)}`,
    );

    /* ── an entry, exactly as the page sends one ─────────────────────── */
    console.log("\nan entry, created the way the page creates it");
    const entry = await Acc_JournalEntry.create({
      entryDate: new Date(`${ON}T00:00:00.000+05:30`),
      narration: `${MARKER} — adjustment posted by the check`,
      type: "adjusting",
      companyId: company._id,
      lines: [
        // accountCode, not ledgerId — this is what the browser sends.
        { accountName: DR.name, accountCode: String(DR._id), ledgerId: DR._id, debit: AMOUNT, credit: 0 },
        { accountName: CR.name, accountCode: String(CR._id), ledgerId: CR._id, debit: 0, credit: AMOUNT },
      ],
      totalDebit: AMOUNT,
      totalCredit: AMOUNT,
      status: "draft",
    });
    check("the entry is stored", Boolean(entry._id));
    check("carrying its company", String(entry.companyId) === String(company._id));

    /* Not posted yet — and nothing should have moved. Without this the next
       check could pass on a balance that was already there. */
    const midway = await trialTotalsFor(DR._id);
    check(
      "a draft entry moves nothing",
      midway.debit === before.dr.debit,
      `${before.dr.debit} → ${midway.debit}`,
    );

    /* ── posting ─────────────────────────────────────────────────────── */
    console.log("\nposting it");
    const owner = { id: entry.createdBy, role: "owner", name: MARKER };
    const result = await posting.postJournalEntry(entry, owner);
    check("posting succeeds", result.ok === true, result.message || "");
    check("and produced a voucher", Boolean(result.voucher?.voucherNumber), JSON.stringify(result.voucher || {}));

    const posted = await Acc_JournalEntry.findById(entry._id).lean();
    check("the entry now points at that voucher", Boolean(posted.voucherId));
    check("and reads as posted", posted.status === "posted", posted.status);

    const voucher = await Acc_Voucher.findById(posted.voucherId).lean();
    check("the voucher is a journal voucher", voucher?.voucherType === "journal", voucher?.voucherType);
    check("it is posted, not left as a draft", voucher?.status === "posted", voucher?.status);
    check("it balances", voucher?.isBalanced === true, `Dr ${voucher?.totalDebit} Cr ${voucher?.totalCredit}`);
    check(
      "it carries both lines against the real ledgers",
      (voucher?.ledgerEntries || []).length === 2 &&
        voucher.ledgerEntries.every((l) => l.ledgerId),
      JSON.stringify((voucher?.ledgerEntries || []).map((l) => `${l.ledgerName} ${l.type} ${l.amount}`)),
    );
    /* In IST, because the entry was written at midnight IST and reading it
       back in UTC lands on the previous evening. */
    const istDay = (d) =>
      d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10) : "";
    check(
      "dated the day the entry is dated, not today",
      istDay(voucher?.voucherDate) === ON,
      istDay(voucher?.voucherDate),
    );
    check(
      "and says where it came from",
      voucher?.sourceSystem === "journal_entry" &&
        String(voucher?.sourceId) === String(entry._id),
      `${voucher?.sourceSystem} / ${voucher?.sourceReference}`,
    );

    /* ── THE ACTUAL QUESTION ─────────────────────────────────────────── */
    console.log("\nwhat the trial balance says now");
    const after = {
      dr: await trialTotalsFor(DR._id),
      cr: await trialTotalsFor(CR._id),
    };
    check(
      `${DR.name} was debited ${AMOUNT}`,
      Math.abs(after.dr.debit - before.dr.debit - AMOUNT) < 0.01,
      `${before.dr.debit.toFixed(2)} → ${after.dr.debit.toFixed(2)}`,
    );
    check(
      `${CR.name} was credited ${AMOUNT}`,
      Math.abs(after.cr.credit - before.cr.credit - AMOUNT) < 0.01,
      `${before.cr.credit.toFixed(2)} → ${after.cr.credit.toFixed(2)}`,
    );

    /* ── posting twice must not double the money ─────────────────────── */
    console.log("\npressing Post again");
    const again = await posting.postJournalEntry(
      await Acc_JournalEntry.findById(entry._id),
      owner,
    );
    check("is recognised as already posted", again.alreadyPosted === true, JSON.stringify(again));
    const afterTwice = await trialTotalsFor(DR._id);
    check(
      "and does not post it a second time",
      Math.abs(afterTwice.debit - after.dr.debit) < 0.01,
      `${after.dr.debit.toFixed(2)} → ${afterTwice.debit.toFixed(2)}`,
    );
    const voucherCount = await Acc_Voucher.countDocuments({ sourceId: entry._id });
    check("exactly one voucher exists for the entry", voucherCount === 1, String(voucherCount));

    /* ── an editor may not post straight to the books ─────────────────── */
    console.log("\nwho is allowed to post");
    check("an owner may post directly", posting.canPostDirectly({ role: "owner" }));
    check("an accountant may", posting.canPostDirectly({ role: "accountant" }));
    check("an editor may not", !posting.canPostDirectly({ role: "editor" }));
    check(
      "unless they hold the direct-post permission",
      posting.canPostDirectly({ role: "editor", permissions: { canPostDirectly: true } }),
    );

    /* ── what it refuses ──────────────────────────────────────────────── */
    console.log("\nwhat posting refuses");
    const noCompany = await posting.resolveLines({
      lines: [{ accountName: "x", debit: 1 }, { accountName: "y", credit: 1 }],
    });
    check("an entry with no company", noCompany.ok === false && noCompany.code === "NO_COMPANY", noCompany.code);

    const badLedger = await posting.resolveLines({
      companyId: company._id,
      lines: [
        { accountName: "A LEDGER THAT DOES NOT EXIST AT ALL", debit: 5 },
        { accountName: CR.name, ledgerId: CR._id, credit: 5 },
      ],
    });
    check(
      "a line that matches no ledger — refused, not guessed at",
      badLedger.ok === false && badLedger.code === "LEDGER_NOT_FOUND",
      badLedger.code,
    );

    const unbalanced = await posting.resolveLines({
      companyId: company._id,
      lines: [
        { accountName: DR.name, ledgerId: DR._id, debit: 100 },
        { accountName: CR.name, ledgerId: CR._id, credit: 90 },
      ],
    });
    check("debits that do not equal credits", unbalanced.ok === false && unbalanced.code === "UNBALANCED", unbalanced.code);

    const bothSides = await posting.resolveLines({
      companyId: company._id,
      lines: [
        { accountName: DR.name, ledgerId: DR._id, debit: 10, credit: 10 },
        { accountName: CR.name, ledgerId: CR._id, credit: 10 },
      ],
    });
    check("a line that is both a debit and a credit", bothSides.ok === false && bothSides.code === "LINE_BOTH_SIDES", bothSides.code);

    /* ── THE ENTRIES ALREADY IN THE DATABASE ──────────────────────────────
       Every entry posted before this fix says "posted" and has no voucher,
       so it is in no report. They are not lost causes: the post route takes
       them, because "posted" was never true for them. This is the path that
       repairs the entries already on the books' front page. */
    console.log("\nan entry posted under the old behaviour");
    const jwt = require("jsonwebtoken");
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/je", require("./routes/Accountant_Routes/Acc_journalEntries"));
    const server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/je`;
    const token = jwt.sign(
      {
        id: "000000000000000000000001",
        role: "owner",
        name: MARKER,
        email: "check@local",
      },
      process.env.JWT_SECRET,
      { expiresIn: "10m" },
    );
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    try {
      /* Exactly the shape the old code left behind: status "posted", no
         voucherId, ledger id sitting in accountCode, no companyId at all on
         the very oldest ones. */
      const legacy = await Acc_JournalEntry.create({
        entryDate: new Date(`${ON}T00:00:00.000+05:30`),
        narration: `${MARKER} — posted the old way, never reached the ledger`,
        type: "adjusting",
        companyId: company._id,
        lines: [
          { accountName: DR.name, accountCode: String(DR._id), debit: AMOUNT, credit: 0 },
          { accountName: CR.name, accountCode: String(CR._id), debit: 0, credit: AMOUNT },
        ],
        totalDebit: AMOUNT,
        totalCredit: AMOUNT,
        status: "posted",
      });

      const listed = await (
        await fetch(`${base}/?companyId=${company._id}&limit=50`, { headers: auth })
      ).json();
      const row = (listed.entries || []).find((e) => String(e._id) === String(legacy._id));
      check("the list finds it", Boolean(row), listed.success === false ? JSON.stringify(listed) : "");
      check(
        "and says plainly that it is not in the ledger",
        row?.needsLedgerPosting === true && row?.postedToLedger === false,
        JSON.stringify({ needs: row?.needsLedgerPosting, posted: row?.postedToLedger }),
      );

      const beforeRepair = await trialTotalsFor(DR._id);
      const repair = await (
        await fetch(`${base}/${legacy._id}/post`, { method: "POST", headers: auth })
      ).json();
      check("posting it is accepted", repair.success === true, JSON.stringify(repair).slice(0, 160));
      check("and it becomes a voucher", Boolean(repair.voucher?.voucherNumber), JSON.stringify(repair.voucher || {}));
      const afterRepair = await trialTotalsFor(DR._id);
      check(
        "the trial balance moves at last",
        Math.abs(afterRepair.debit - beforeRepair.debit - AMOUNT) < 0.01,
        `${beforeRepair.debit.toFixed(2)} → ${afterRepair.debit.toFixed(2)}`,
      );

      /* ── what the route refuses ─────────────────────────────────────── */
      console.log("\nwhat the route refuses");
      const noCo = await fetch(base, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          entryDate: ON,
          narration: `${MARKER} — no company`,
          lines: [
            { accountName: DR.name, accountCode: String(DR._id), debit: 1 },
            { accountName: CR.name, accountCode: String(CR._id), credit: 1 },
          ],
        }),
      });
      check(
        "an entry with no company is refused at the door",
        noCo.status === 400,
        String(noCo.status),
      );

      /* Created through the route, the ledger id the page smuggles in
         `accountCode` must land in the real field. */
      const viaRoute = await (
        await fetch(base, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            companyId: String(company._id),
            entryDate: ON,
            narration: `${MARKER} — created through the route`,
            type: "adjusting",
            lines: [
              { accountName: DR.name, accountCode: String(DR._id), debit: 500 },
              { accountName: CR.name, accountCode: String(CR._id), credit: 500 },
            ],
          }),
        })
      ).json();
      check("the route creates an entry", viaRoute.success === true, JSON.stringify(viaRoute).slice(0, 140));
      const stored = await Acc_JournalEntry.findById(viaRoute.entry?._id).lean();
      check(
        "and the line now points at a real ledger, not just a name",
        String(stored?.lines?.[0]?.ledgerId) === String(DR._id),
        String(stored?.lines?.[0]?.ledgerId),
      );
      check(
        "created as a draft — it has not touched the books yet",
        stored?.status === "draft" && !stored?.voucherId,
        stored?.status,
      );
    } finally {
      await new Promise((r) => server.close(r));
    }

    /* ── DOES IT REACH EVERY REPORT? ──────────────────────────────────────
       The trial balance is one aggregation. The complaint was broader than
       that — "it didn't impact it in the trial balance and everywhere it
       needed" — so this drives the REAL report endpoints, over HTTP, the way
       the browser does, and watches all of them at once.

       The entry is chosen to cut across the reports rather than sit inside
       one: an EXPENSE ledger on the debit side, which belongs to the profit
       and loss, and a LIABILITY on the credit side, which belongs to the
       balance sheet. One entry, five reports, and each has to move by the
       same amount and give it back when the entry is voided. */
    console.log("\nthe same entry, seen from every report");

    const expenseLed = await Acc_Ledger.findOne({
      companyId: company._id,
      isActive: true,
      groupName: "Indirect Expenses",
    })
      .select("_id name groupName")
      .lean();
    const liabilityLed = await Acc_Ledger.findOne({
      companyId: company._id,
      isActive: true,
      groupName: "Other Current Liabilities",
    })
      .select("_id name groupName")
      .lean();
    check(
      "found an expense ledger and a liability ledger",
      Boolean(expenseLed && liabilityLed),
      `${expenseLed?.name} / ${liabilityLed?.name}`,
    );

    if (expenseLed && liabilityLed) {
      const jwt2 = require("jsonwebtoken");
      const express2 = require("express");
      const app2 = express2();
      app2.use(express2.json());
      app2.use("/je", require("./routes/Accountant_Routes/Acc_journalEntries"));
      app2.use("/reports", require("./routes/Accountant_Routes/Acc_books"));
      app2.use("/coa", require("./routes/Accountant_Routes/Acc_chartOfAccounts"));
      const srv2 = await new Promise((r) => {
        const x = app2.listen(0, () => r(x));
      });
      const b2 = `http://127.0.0.1:${srv2.address().port}`;
      const tok2 = jwt2.sign(
        { id: "000000000000000000000001", role: "owner", name: MARKER, email: "check@local" },
        process.env.JWT_SECRET,
        { expiresIn: "10m" },
      );
      const h2 = { Authorization: `Bearer ${tok2}`, "Content-Type": "application/json" };
      const AMT = 7777.77;
      const FY_FROM = "2025-04-01";
      const FY_TO = "2026-03-31";

      /* One snapshot function, called before and after, so the two readings
         cannot drift apart by being written twice. */
      const readAllReports = async () => {
        const g = async (u) => {
          const r = await fetch(`${b2}${u}`, { headers: h2 });
          return r.status === 200 ? r.json() : { __status: r.status };
        };

        const tb = await g(
          `/reports/trial-balance?companyId=${company._id}&startDate=${FY_FROM}&endDate=${FY_TO}`,
        );
        const rowFor = (id) =>
          (tb.ledgers || []).find((x) => String(x.ledgerId) === String(id)) || {};

        const pl = await g(
          `/reports/profit-loss?companyId=${company._id}&from=${FY_FROM}&to=${FY_TO}`,
        );
        const bs = await g(`/reports/balance-sheet?companyId=${company._id}&asOf=${FY_TO}`);
        const db2 = await g(
          `/reports/day-book?companyId=${company._id}&date=${ON}&limit=200`,
        );
        const stmt = await g(
          `/coa/ledgers/${expenseLed._id}/statement?companyId=${company._id}&startDate=${FY_FROM}&endDate=${FY_TO}`,
        );

        return {
          tbExpenseDr: Number(rowFor(expenseLed._id).debit || 0),
          tbLiabilityCr: Number(rowFor(liabilityLed._id).credit || 0),
          tbTotalDr: Number(tb.totals?.debit ?? 0),
          tbTotalCr: Number(tb.totals?.credit ?? 0),
          /* Field names taken from the live responses, not guessed. The first
             run of this check read `totalExpenses`/`totalLiabilities`/`rows`,
             found undefined, scored them as 0 and reported three working
             reports as broken — while `netProfit`, which does exist, moved
             correctly and gave the lie away. */
          plExpenses: Number(pl.expense?.total ?? 0),
          plRevenue: Number(pl.revenue?.total ?? 0),
          plNet: Number(pl.netProfit ?? 0),
          bsLiabilities: Number(bs.liabilities?.total ?? 0),
          bsBalanced: Boolean(bs.check?.isBalanced),
          dayBookCount: (db2.vouchers || db2.entries || db2.rows || []).length,
          dayBookHasOurs: (db2.vouchers || db2.entries || db2.rows || []).some(
            (v) => String(v.narration || "").includes(MARKER),
          ),
          stmtRows: (stmt.lines || []).length,
          stmtDebit: Number(stmt.totals?.debit ?? 0),
          raw: { tb: tb.__status, pl: pl.__status, bs: bs.__status, db: db2.__status, stmt: stmt.__status },
        };
      };

      try {
        const R0 = await readAllReports();
        check(
          "every report answers before we touch anything",
          Object.values(R0.raw).every((x) => x === undefined),
          JSON.stringify(R0.raw),
        );
        console.log(
          `  before — TB: ${expenseLed.name} Dr ${R0.tbExpenseDr.toFixed(2)} · ` +
            `${liabilityLed.name} Cr ${R0.tbLiabilityCr.toFixed(2)}`,
        );
        console.log(
          `           P&L expenses ${R0.plExpenses.toFixed(2)} · ` +
            `BS liabilities ${R0.bsLiabilities.toFixed(2)} · ` +
            `day book ${R0.dayBookCount} · statement rows ${R0.stmtRows}`,
        );

        /* Created and posted through the HTTP routes, exactly as the browser
           does it — not by calling the service directly. */
        const created = await (
          await fetch(`${b2}/je`, {
            method: "POST",
            headers: h2,
            body: JSON.stringify({
              companyId: String(company._id),
              entryDate: ON,
              narration: `${MARKER} — cross-report entry`,
              type: "adjusting",
              lines: [
                { accountName: expenseLed.name, accountCode: String(expenseLed._id), debit: AMT, credit: 0 },
                { accountName: liabilityLed.name, accountCode: String(liabilityLed._id), debit: 0, credit: AMT },
              ],
            }),
          })
        ).json();
        check("the entry is created over HTTP", created.success === true, JSON.stringify(created).slice(0, 140));

        const jeId = created.entry?._id;
        const postRes = await (
          await fetch(`${b2}/je/${jeId}/post`, { method: "POST", headers: h2 })
        ).json();
        check("and posted over HTTP", postRes.success === true, JSON.stringify(postRes).slice(0, 160));
        console.log(`  posted as ${postRes.voucher?.voucherNumber}`);

        const R1 = await readAllReports();
        console.log(
          `  after  — TB: Dr ${R1.tbExpenseDr.toFixed(2)} · Cr ${R1.tbLiabilityCr.toFixed(2)}`,
        );
        console.log(
          `           P&L expenses ${R1.plExpenses.toFixed(2)} · ` +
            `BS liabilities ${R1.bsLiabilities.toFixed(2)} · ` +
            `day book ${R1.dayBookCount} · statement rows ${R1.stmtRows}`,
        );

        const moved = (a, b, by) => Math.abs(b - a - by) < 0.02;

        check(
          `TRIAL BALANCE — ${expenseLed.name} debited ${AMT}`,
          moved(R0.tbExpenseDr, R1.tbExpenseDr, AMT),
          `${R0.tbExpenseDr.toFixed(2)} → ${R1.tbExpenseDr.toFixed(2)}`,
        );
        check(
          `TRIAL BALANCE — ${liabilityLed.name} credited ${AMT}`,
          moved(R0.tbLiabilityCr, R1.tbLiabilityCr, AMT),
          `${R0.tbLiabilityCr.toFixed(2)} → ${R1.tbLiabilityCr.toFixed(2)}`,
        );
        check(
          "TRIAL BALANCE — still balances overall",
          Math.abs(R1.tbTotalDr - R1.tbTotalCr) < 1,
          `Dr ${R1.tbTotalDr.toFixed(2)} vs Cr ${R1.tbTotalCr.toFixed(2)}`,
        );
        check(
          `PROFIT & LOSS — expenses rose by ${AMT}`,
          moved(R0.plExpenses, R1.plExpenses, AMT),
          `${R0.plExpenses.toFixed(2)} → ${R1.plExpenses.toFixed(2)}`,
        );
        check(
          "PROFIT & LOSS — and the net figure fell by the same",
          moved(R1.plNet, R0.plNet, AMT),
          `${R0.plNet.toFixed(2)} → ${R1.plNet.toFixed(2)}`,
        );
        check(
          `BALANCE SHEET — liabilities rose by ${AMT}`,
          moved(R0.bsLiabilities, R1.bsLiabilities, AMT),
          `${R0.bsLiabilities.toFixed(2)} → ${R1.bsLiabilities.toFixed(2)}`,
        );
        check(
          "DAY BOOK — the voucher appears on its date",
          R1.dayBookHasOurs && R1.dayBookCount === R0.dayBookCount + 1,
          `${R0.dayBookCount} → ${R1.dayBookCount}, found: ${R1.dayBookHasOurs}`,
        );
        check(
          "LEDGER STATEMENT — the expense ledger gained a line",
          R1.stmtRows === R0.stmtRows + 1,
          `${R0.stmtRows} → ${R1.stmtRows}`,
        );
        check(
          `LEDGER STATEMENT — and its debit total rose by ${AMT}`,
          moved(R0.stmtDebit, R1.stmtDebit, AMT),
          `${R0.stmtDebit.toFixed(2)} → ${R1.stmtDebit.toFixed(2)}`,
        );
        check(
          "BALANCE SHEET — still balances",
          R1.bsBalanced,
          `difference reported by the report itself`,
        );

        /* ── and voiding it gives all of that back ───────────────────── */
        console.log("\nvoiding it, and watching every report again");
        const voidRes = await (
          await fetch(`${b2}/je/${jeId}/void`, {
            method: "POST",
            headers: h2,
            body: JSON.stringify({ reason: "check" }),
          })
        ).json();
        check("void is accepted over HTTP", voidRes.success === true, JSON.stringify(voidRes).slice(0, 140));

        const R2 = await readAllReports();
        check(
          "TRIAL BALANCE — back where it started",
          Math.abs(R2.tbExpenseDr - R0.tbExpenseDr) < 0.02 &&
            Math.abs(R2.tbLiabilityCr - R0.tbLiabilityCr) < 0.02,
          `Dr ${R2.tbExpenseDr.toFixed(2)} (was ${R0.tbExpenseDr.toFixed(2)})`,
        );
        check(
          "PROFIT & LOSS — back where it started",
          Math.abs(R2.plExpenses - R0.plExpenses) < 0.02,
          `${R2.plExpenses.toFixed(2)} vs ${R0.plExpenses.toFixed(2)}`,
        );
        check(
          "BALANCE SHEET — back where it started",
          Math.abs(R2.bsLiabilities - R0.bsLiabilities) < 0.02,
          `${R2.bsLiabilities.toFixed(2)} vs ${R0.bsLiabilities.toFixed(2)}`,
        );
        check(
          "DAY BOOK — the voided voucher is no longer listed",
          R2.dayBookCount === R0.dayBookCount,
          `${R2.dayBookCount} vs ${R0.dayBookCount}`,
        );
        check(
          "LEDGER STATEMENT — back where it started",
          R2.stmtRows === R0.stmtRows,
          `${R2.stmtRows} vs ${R0.stmtRows}`,
        );

        /* ── edit and cancel, over HTTP ──────────────────────────────── */
        console.log("\nediting a draft, and cancelling one");
        const draft = await (
          await fetch(`${b2}/je`, {
            method: "POST",
            headers: h2,
            body: JSON.stringify({
              companyId: String(company._id),
              entryDate: ON,
              narration: `${MARKER} — draft to edit`,
              type: "standard",
              lines: [
                { accountName: expenseLed.name, accountCode: String(expenseLed._id), debit: 100, credit: 0 },
                { accountName: liabilityLed.name, accountCode: String(liabilityLed._id), debit: 0, credit: 100 },
              ],
            }),
          })
        ).json();
        const draftId = draft.entry?._id;

        const edited = await (
          await fetch(`${b2}/je/${draftId}`, {
            method: "PUT",
            headers: h2,
            body: JSON.stringify({
              narration: `${MARKER} — draft to edit (amended)`,
              entryDate: ON,
              type: "adjusting",
              lines: [
                { accountName: expenseLed.name, accountCode: String(expenseLed._id), debit: 250, credit: 0 },
                { accountName: liabilityLed.name, accountCode: String(liabilityLed._id), debit: 0, credit: 250 },
              ],
            }),
          })
        ).json();
        check("a draft can be edited", edited.success === true, JSON.stringify(edited).slice(0, 140));
        const reread = await Acc_JournalEntry.findById(draftId).lean();
        check(
          "and the new figures are stored",
          reread?.totalDebit === 250 && reread?.type === "adjusting",
          `${reread?.totalDebit} / ${reread?.type}`,
        );
        check(
          "editing does not put it in the books",
          !reread?.voucherId,
          String(reread?.voucherId || ""),
        );

        /* An unbalanced edit must be refused, or Edit becomes a way to break
           the very invariant creation enforces. */
        const badEdit = await fetch(`${b2}/je/${draftId}`, {
          method: "PUT",
          headers: h2,
          body: JSON.stringify({
            lines: [
              { accountName: expenseLed.name, accountCode: String(expenseLed._id), debit: 250, credit: 0 },
              { accountName: liabilityLed.name, accountCode: String(liabilityLed._id), debit: 0, credit: 90 },
            ],
          }),
        });
        check("an unbalanced edit is refused", badEdit.status === 400, String(badEdit.status));

        const cancelled = await (
          await fetch(`${b2}/je/${draftId}/cancel`, {
            method: "POST",
            headers: h2,
            body: JSON.stringify({ reason: "not needed" }),
          })
        ).json();
        check("a draft can be cancelled", cancelled.success === true, JSON.stringify(cancelled).slice(0, 140));
        const afterCancel = await Acc_JournalEntry.findById(draftId).lean();
        check(
          "cancelled is its own state, not void",
          afterCancel?.status === "cancelled",
          afterCancel?.status,
        );
        check("and the reason is kept", afterCancel?.cancelReason === "not needed", afterCancel?.cancelReason);

        /* A posted entry may not be edited or cancelled — it is a voucher
           other reports have already counted. */
        const postedEntry = await Acc_JournalEntry.findById(jeId).lean();
        const editPosted = await fetch(`${b2}/je/${jeId}`, {
          method: "PUT",
          headers: h2,
          body: JSON.stringify({ narration: "should not be allowed" }),
        });
        check(
          "a posted entry cannot be edited",
          editPosted.status === 400,
          `${editPosted.status} (entry is ${postedEntry?.status})`,
        );
        const cancelPosted = await fetch(`${b2}/je/${jeId}/cancel`, {
          method: "POST",
          headers: h2,
          body: JSON.stringify({}),
        });
        check(
          "and cannot be cancelled — void is the way out",
          cancelPosted.status === 400,
          String(cancelPosted.status),
        );

        /* The View panel's own payload. */
        const view = await (await fetch(`${b2}/je/${jeId}`, { headers: h2 })).json();
        check("the view route returns the entry", view.success === true);
        check(
          "with the voucher it became alongside it",
          Boolean(view.voucher?.voucherNumber),
          JSON.stringify(view.voucher || {}).slice(0, 100),
        );
        check(
          "and says what may be done to it",
          view.can && view.can.edit === false && view.can.delete === false,
          JSON.stringify(view.can || {}),
        );
      } finally {
        await new Promise((r) => srv2.close(r));
      }
    }

    /* ── voiding takes it back out ────────────────────────────────────── */
    console.log("\nvoiding it");
    /* Measured against the total immediately before the void, not against the
       total at the top of the run — the repair entry above posts to the same
       ledger, and comparing with a stale baseline reported a working void as
       broken. */
    const beforeVoid = await trialTotalsFor(DR._id);
    const live = await Acc_JournalEntry.findById(entry._id);
    const voided = await posting.voidJournalEntry(live);
    check("the voucher is voided", voided.voidedVoucher === true);
    const afterVoid = await trialTotalsFor(DR._id);
    check(
      "and the trial balance gives that money back",
      Math.abs(beforeVoid.debit - afterVoid.debit - AMOUNT) < 0.01,
      `${beforeVoid.debit.toFixed(2)} → ${afterVoid.debit.toFixed(2)}, expected a fall of ${AMOUNT}`,
    );
  } finally {
    console.log(`\n  cleanup: ${await cleanUp()}`);
  }

  /* ── nothing left behind ────────────────────────────────────────────── */
  const strayE = await db
    .collection("acc_journal_entries")
    .countDocuments({ narration: { $regex: MARKER } });
  check("no test entry left behind", strayE === 0, String(strayE));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try {
    console.error("cleanup:", await cleanUp());
  } catch (err) {
    console.error(`CLEANUP FAILED — remove rows whose narration contains "${MARKER}":`, err.message);
  }
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
