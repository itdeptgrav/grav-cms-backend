const XLSX = require("xlsx");
const { parseBankStatement, directionOf } = require("../../services/accounting/bankStatementParser");

const book = (aoa, bookType = "biff8") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet0");
  return XLSX.write(wb, { type: "buffer", bookType });
};

/* The HDFC "Accountstmt_<account>_<stamp>.XLS" layout (13 Oct 2026). */
const hdfc = [
  ["Account Number", "50200000001111", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["Customer Name", "TEST COMPANY PVT LTD", "", "", "", "", "", ""],
  ["Account Currency", "INR", "", "", "", "", "", ""],
  ["Opening Balance", "30000.00", "", "", "", "", "", ""],
  ["Closing Balance", "29001.00", "", "", "", "", "", ""],
  ["From Date", "01/09/2026", "", "", "", "", "", ""],
  ["To Date", "30/09/2026", "", "", "", "", "", ""],
  ["Total Debit Count", "1", "", "", "", "", "", ""],
  ["Total Credit Count", "1", "", "", "", "", "", ""],
  ["Total Debit Amount", "1000.00", "", "", "", "", "", ""],
  ["Total Credit Amount", "1.00", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["Transaction Date", "Transaction Description", "Transaction Amount", "Debit / Credit", "Reference No.", "Value Date", "Transaction Branch", "Running Balance"],
  ["19/09/2026 16:12:38", "Enet form HB-185", "1000.00", "D", "HDFCH0001", "19/09/2026", "CBX Internet System Mumbai", "29001.00"],
  ["04/09/2026 07:58:55", "UPI SETTLEMENT", "1.00", "C", " ", "04/09/2026", "DB OPS MUMBAI", "30001.00"],
];

describe("HDFC statements", () => {
  const r = parseBankStatement(book(hdfc));

  test("are recognised and read from the key/value block", () => {
    expect(r).toMatchObject({
      bankName: "HDFC Bank",
      format: "hdfc",
      accountNumber: "50200000001111",
      accountHolder: "TEST COMPANY PVT LTD",
      openingBalance: 30000,
      closingBalance: 29001,
    });
    expect(r.periodFrom.toISOString()).toBe("2026-08-31T18:30:00.000Z"); // 1 Sep, IST
  });

  test("the D / C column decides debit or credit; the amount comes from its own column", () => {
    expect(r.transactions.map((t) => [t.debit, t.credit])).toEqual([[1000, 0], [0, 1]]);
    expect(r.transactions[0]).toMatchObject({ chequeNo: "HDFCH0001", branch: "CBX Internet System Mumbai", balance: 29001 });
  });

  test("the date is the value date, and a time after the date is ignored", () => {
    expect(r.transactions[0].valueDate.toISOString()).toBe("2026-09-18T18:30:00.000Z"); // 19 Sep, IST
  });

  test("the lines add up: opening − debits + credits = closing", () => {
    const dr = r.transactions.reduce((s, t) => s + t.debit, 0);
    const cr = r.transactions.reduce((s, t) => s + t.credit, 0);
    expect(r.openingBalance - dr + cr).toBe(r.closingBalance);
  });

  test("a line whose D / C mark cannot be read stops the import, rather than guessing", () => {
    const bad = hdfc.map((row) => [...row]);
    bad[15][3] = "?";
    expect(() => parseBankStatement(book(bad))).toThrow(/no readable Debit \/ Credit mark/);
  });
});

test("Indian Bank's two-column layout still reads as before", () => {
  const r = parseBankStatement(book([
    ["INDIAN BANK"],
    ["Account Number", "Transaction Date", "Value Date", "Description", "Cheque No", "Debit Amount", "Credit Amount", "Balance", "Remitter Branch"],
    ["6123453512", "01-10-2026", "01-10-2026", "Balance B/F", "", "", "", "1,20,000.00 CR", ""],
    ["6123453512", "02-10-2026", "02-10-2026", "NEFT/RISHEE RAY", "", "", "50,000.00", "1,70,000.00 CR", "FORT"],
    ["6123453512", "03-10-2026", "03-10-2026", "CHQ PAID", "000123", "20,000.00", "", "1,50,000.00 CR", "BBSR"],
  ], "xlsx"));
  expect(r).toMatchObject({ format: "indian_bank", accountNumber: "6123453512", openingBalance: 120000 });
  expect(r.transactions.map((t) => [t.debit, t.credit, t.balance])).toEqual([[0, 50000, 170000], [20000, 0, 150000]]);
});

test("direction marks", () => {
  expect(["D", "Dr", "debit", "W"].map(directionOf)).toEqual(["debit", "debit", "debit", "debit"]);
  expect(["C", "CR.", "Credit", "Deposit"].map(directionOf)).toEqual(["credit", "credit", "credit", "credit"]);
  expect(directionOf("")).toBe(null);
});
