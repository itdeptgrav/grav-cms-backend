// test/accountant/accounting-audit.test.js
//
// The rules the 16 Oct 2026 accounting audit put in one place, each pinned:
// days are India's days, a ledger's opening balance has one reading, a live
// balance is opening + posted vouchers (never the cached figure), and an
// invoice's header (GST breakup, grand total, financial year) is read off its
// ledger lines.
"use strict";

const mongoose = require("mongoose");
const { istStart, istEnd, istMonthBounds } = require("../../services/accounting/istDates");
const { openingSigned, liveBalances } = require("../../services/accounting/ledgerBalance");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const id = () => new mongoose.Types.ObjectId();

describe("India's calendar days", () => {
  test("a plain day is that whole day in India", () => {
    expect(istStart("2026-04-01").toISOString()).toBe("2026-03-31T18:30:00.000Z");
    expect(istEnd("2026-04-01").toISOString()).toBe("2026-04-01T18:29:59.999Z");
  });

  test("a voucher stored at India's midnight is inside its own day, not the day before", () => {
    const atIstMidnight = new Date("2026-03-31T18:30:00.000Z"); // 1 Apr in India
    expect(atIstMidnight >= istStart("2026-04-01")).toBe(true);
    expect(atIstMidnight <= istEnd("2026-03-31")).toBe(false);
  });

  test("a voucher stored at UTC midnight is inside the same day too", () => {
    const atUtcMidnight = new Date("2026-04-01T00:00:00.000Z");
    expect(atUtcMidnight >= istStart("2026-04-01") && atUtcMidnight <= istEnd("2026-04-01")).toBe(true);
  });

  test("a full timestamp or a Date is left as the instant it is; empty is null", () => {
    const d = new Date("2026-05-05T10:00:00Z");
    expect(istStart(d)).toBe(d);
    expect(istEnd("2026-05-05T10:00:00Z").toISOString()).toBe("2026-05-05T10:00:00.000Z");
    expect(istStart("")).toBeNull();
    expect(istEnd(undefined)).toBeNull();
  });

  test("a month runs from India's first midnight to the instant before the next", () => {
    const { from, to } = istMonthBounds(2026, 2);
    expect(from.toISOString()).toBe("2026-01-31T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-02-28T18:29:59.999Z");
    const dec = istMonthBounds(2026, 12);
    expect(dec.to.toISOString()).toBe("2026-12-31T18:29:59.999Z");
  });
});

describe("one reading of an opening balance", () => {
  test("signed and unsigned-with-a-side give the same figure", () => {
    expect(openingSigned({ openingBalance: 500 })).toBe(500);
    expect(openingSigned({ openingBalance: 500, openingBalanceType: "Dr" })).toBe(500);
    expect(openingSigned({ openingBalance: 500, openingBalanceType: "Cr" })).toBe(-500);
    expect(openingSigned({ openingBalance: -500 })).toBe(-500);
    // a negative figure is a credit even when the side was left at Dr
    expect(openingSigned({ openingBalance: -500, openingBalanceType: "Dr" })).toBe(-500);
    // already signed AND marked Cr is not flipped back to a debit
    expect(openingSigned({ openingBalance: -500, openingBalanceType: "Cr" })).toBe(-500);
    expect(openingSigned({})).toBe(0);
    expect(openingSigned(null)).toBe(0);
  });
});

/* a balanced voucher in the shape the forms post */
function voucher(companyId, { type = "journal", status = "posted", date = "2026-06-10", lines, ...rest }) {
  return {
    companyId,
    voucherType: type,
    voucherNumber: `T-${Math.random().toString(36).slice(2, 9)}`,
    voucherDate: new Date(`${date}T00:00:00.000+05:30`),
    status,
    grandTotal: 0,
    ledgerEntries: lines.map(([ledgerId, ledgerName, t, amount]) => ({ ledgerId, ledgerName, type: t, amount })),
    ...rest,
  };
}

describe("a live balance is opening + posted vouchers", () => {
  test("drafts, cancelled and optional vouchers do not count; the cached figure is ignored", async () => {
    const companyId = id();
    const cash = { _id: id(), name: "Cash", openingBalance: 1000, currentBalance: 999999 };
    const rent = { _id: id(), name: "Rent", openingBalance: 0, currentBalance: -5 };
    const line = (amt) => [[rent._id, "Rent", "Dr", amt], [cash._id, "Cash", "Cr", amt]];
    await Acc_Voucher.create([
      voucher(companyId, { lines: line(300) }),
      voucher(companyId, { lines: line(50), status: "draft" }),
      voucher(companyId, { lines: line(70), status: "cancelled" }),
      voucher(companyId, { lines: line(90), isOptional: true }),
      voucher(id(), { lines: line(400) }), // another company's
    ]);
    const live = await liveBalances(companyId, [cash, rent]);
    expect(live.get(String(cash._id))).toMatchObject({ balance: 700, type: "Dr" });
    expect(live.get(String(rent._id))).toMatchObject({ balance: 300, type: "Dr" });
  });

  test("a credit balance is signed − (as the cached field always was) and typed Cr", async () => {
    const companyId = id();
    const bank = { _id: id(), name: "Bank", openingBalance: 100, openingBalanceType: "Cr" };
    const party = { _id: id(), name: "Party" };
    await Acc_Voucher.create(voucher(companyId, { lines: [[party._id, "Party", "Dr", 50], [bank._id, "Bank", "Cr", 50]] }));
    const live = await liveBalances(companyId, [bank]);
    expect(live.get(String(bank._id))).toMatchObject({ balance: -150, type: "Cr" });
  });
});

describe("an invoice's header is read off its lines", () => {
  test("sales: GST per component on the Cr side, grand total = the party's line", async () => {
    const companyId = id();
    const customer = id();
    const v = await Acc_Voucher.create(
      voucher(companyId, {
        type: "sales",
        partyLedgerId: customer,
        grandTotal: 99999, // what a form's own arithmetic sent
        gstBreakup: { cgst: 1, sgst: 1, igst: 0 },
        lines: [
          [customer, "Customer", "Dr", 1050],
          [id(), "Sales", "Cr", 1000],
          [id(), "Output CGST 2.5%", "Cr", 25],
          [id(), "Output SGST 2.5%", "Cr", 25],
        ],
      }),
    );
    expect(v.grandTotal).toBe(1050);
    expect(v.gstBreakup.cgst).toBe(25);
    expect(v.gstBreakup.sgst).toBe(25);
    expect(v.gstBreakup.igst).toBe(0);
    expect(v.totalTax).toBe(50);
  });

  test("purchase under reverse charge: the RCM liability and its credit are not the bill's tax", async () => {
    const companyId = id();
    const supplier = id();
    const v = await Acc_Voucher.create(
      voucher(companyId, {
        type: "purchase",
        partyLedgerId: supplier,
        grandTotal: 1,
        lines: [
          [id(), "Freight", "Dr", 1000],
          [id(), "Input IGST RCM", "Dr", 50],
          [id(), "Output IGST RCM Payable", "Cr", 50],
          [supplier, "Transporter", "Cr", 1000],
        ],
      }),
    );
    expect(v.grandTotal).toBe(1000);
    expect(v.gstBreakup ? v.gstBreakup.igst || 0 : 0).toBe(0);
  });

  test("credit note: the reversed output tax sits on the Dr side", async () => {
    const companyId = id();
    const customer = id();
    const v = await Acc_Voucher.create(
      voucher(companyId, {
        type: "credit_note",
        partyLedgerId: customer,
        grandTotal: 0,
        lines: [
          [id(), "Sales Returns", "Dr", 200],
          [id(), "Output IGST 5%", "Dr", 10],
          [customer, "Customer", "Cr", 210],
        ],
      }),
    );
    expect(v.grandTotal).toBe(210);
    expect(v.gstBreakup.igst).toBe(10);
  });

  test("a journal's header is left as it was sent", async () => {
    const companyId = id();
    const v = await Acc_Voucher.create(
      voucher(companyId, { grandTotal: 77, lines: [[id(), "A", "Dr", 10], [id(), "B", "Cr", 10]] }),
    );
    expect(v.grandTotal).toBe(77);
  });

  test("the financial year is India's: 1 April at India's midnight is the new year", async () => {
    const v = await Acc_Voucher.create(
      voucher(id(), { date: "2026-04-01", lines: [[id(), "A", "Dr", 10], [id(), "B", "Cr", 10]] }),
    );
    expect(v.voucherDate.toISOString()).toBe("2026-03-31T18:30:00.000Z");
    expect(v.financialYear).toBe("2026-27");
  });
});

describe("the cash flow statement attributes cash to the other side of each voucher", () => {
  const { buildCashFlow, sectionOfRoot } = require("../../services/accounting/cashFlowStatement");
  const L = (n) => `6a${String(n).padStart(22, "0")}`;
  const BANK = L(1), CASH = L(2), CUST = L(3), RENT = L(4), GST = L(5), MACH = L(6), LOAN = L(7);
  const info = new Map([
    [CUST, { name: "Customer", rootName: "Current Assets" }],
    [RENT, { name: "Rent", rootName: "Indirect Expenses" }],
    [GST, { name: "Input GST", rootName: "Current Liabilities" }],
    [MACH, { name: "Machinery", rootName: "Fixed Assets" }],
    [LOAN, { name: "Director's loan", rootName: "Loans (Liability)" }],
  ]);
  const v = (...lines) => ({ ledgerEntries: lines.map(([ledgerId, type, amount]) => ({ ledgerId, type, amount })) });
  const st = buildCashFlow({
    cashIds: new Set([BANK, CASH]),
    ledgerInfo: info,
    openingCash: 1000,
    vouchers: [
      v([BANK, "Dr", 5000], [CUST, "Cr", 5000]), // receipt
      v([RENT, "Dr", 1000], [GST, "Dr", 180], [BANK, "Cr", 1180]), // rent with GST
      v([MACH, "Dr", 2000], [BANK, "Cr", 2000]), // a machine
      v([BANK, "Dr", 3000], [LOAN, "Cr", 3000]), // a loan
      v([CASH, "Dr", 400], [BANK, "Cr", 400]), // a contra
    ],
  });

  test("each section holds its counterparts, signed in (+) and out (−)", () => {
    expect(st.activities.operating.net).toBe(3820);
    expect(st.activities.operating.lines.map((l) => [l.ledgerName, l.net])).toEqual([
      ["Customer", 5000],
      ["Rent", -1000],
      ["Input GST", -180],
    ]);
    expect(st.activities.investing.net).toBe(-2000);
    expect(st.activities.financing.net).toBe(3000);
  });

  test("a contra is an internal transfer, not cash in or out", () => {
    expect(st.internalTransfers).toEqual({ inflow: 400, outflow: 400 });
  });

  test("the sections add up to closing − opening", () => {
    const { operating, investing, financing } = st.activities;
    expect(st.openingCash).toBe(1000);
    expect(st.closingCash).toBe(5820);
    expect(operating.net + investing.net + financing.net).toBe(st.closingCash - st.openingCash);
  });

  test("the section is the primary group's", () => {
    expect(sectionOfRoot("Investments")).toBe("investing");
    expect(sectionOfRoot("Capital Account")).toBe("financing");
    expect(sectionOfRoot("Loans & Advances (Liability)")).toBe("financing");
    expect(sectionOfRoot("Sundry Debtors")).toBe("operating");
    expect(sectionOfRoot("")).toBe("operating");
  });
});
