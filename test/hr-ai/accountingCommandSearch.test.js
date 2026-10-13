// test/hr-ai/accountingCommandSearch.test.js
//
// CMD/CTRL K FOR THE BOOKS — ONE COMPANY'S BOOKS, AND ONLY THOSE.
//
// Company B shares a customer name, an invoice number and a stock item name
// with company A, so every answer below would show B's figure if any query
// forgot its companyId. Company A has a draft invoice beside a posted one, so
// a total that forgot "posted" is caught too.
"use strict";

const fs = require("fs");
const path = require("path");
const service = require("../../services/ai/accountingCommandSearch.service");
const { seedBooks } = require("../support/accountingCommandFixtures");

let books;
beforeEach(async () => {
  books = await seedBooks();
});

const ask = (query, companyId = books.A) => service.search({ companyId: String(companyId), query, now: Date.UTC(2026, 9, 8, 6) });
const rows = (out) => (out.groups || []).flatMap((g) => g.results);
const said = (out) => [out.note || "", ...rows(out).map((r) => `${r.title} ${r.subtitle || ""} ${r.value || ""} ${JSON.stringify(r.card || "")}`)].join(" || ");

describe("a record by what you would type", () => {
  test("a voucher number opens THAT company's voucher, with its card", async () => {
    const out = await ask("INV/0012");
    expect(out.state).toBe("answered");
    const [row] = rows(out);
    expect(row.href).toBe(`/accountant/invoices/${books.vouchers.invoice._id}`);
    expect(row.card.title).toBe("INV/0012");
    expect(row.card.facts.find((f) => f.label === "Total").value).toBe("₹1,200");
    expect(said(out)).not.toMatch(/9,999/);
  });

  test("the same number in company B answers with B's voucher only", async () => {
    const out = await ask("INV/0012", books.B);
    expect(said(out)).toMatch(/9,999/);
    expect(said(out)).not.toMatch(/1,200/);
  });

  test("a ledger by name shows its balance; a GSTIN finds the same ledger", async () => {
    const byName = rows(await ask("Gaurav Enterprises"));
    expect(byName[0].href).toBe(`/accountant/ledger/${books.ledgers.gaurav._id}`);
    expect(byName[0].card.facts.find((f) => f.label === "Balance").value).toBe("₹700 Dr");
    const byGstin = rows(await ask("24AAACG1234F1Z5"));
    expect(byGstin[0].href).toBe(byName[0].href);
  });

  test("a stock item has no page, so its card IS the answer", async () => {
    const [row] = rows(await ask("Cotton Fabric"));
    expect(row.kind).toBe("fact");
    expect(row.card.facts.find((f) => f.label === "In stock").value).toBe("120 Mtr");
  });

  test("a name said loosely finds the closest ledger, this company's, marked as near", async () => {
    const out = await ask("gaurav enterprize");
    expect(out.note).toBe('No exact match for "gaurav enterprize" — closest matches.');
    const [first] = rows(out);
    expect(first.title).toBe("Gaurav Enterprises");
    expect(first.metadata.approximate).toBe(true);
    expect(said(out)).not.toMatch(/9,999/);
  });

  test("a number nobody issued finds nothing — and lists nothing", async () => {
    const out = await ask("INV/9999");
    expect(out.state).toBe("no_match");
    expect(rows(out)).toEqual([]);
  });
});

describe("questions", () => {
  test("a balance, from posted vouchers only — the draft invoice does not count", async () => {
    const out = await ask("balance of Gaurav Enterprises");
    expect(rows(out)[0].title).toBe("Gaurav Enterprises's balance is ₹700 Dr (posted vouchers).");
    /* A question's card sits beneath its answer; it does not replace it. */
    expect(rows(out)[0].card.lead).toBe(false);
  });

  test("a stock figure, this company's", async () => {
    expect(rows(await ask("stock of cotton fabric"))[0].title).toBe("Cotton Fabric: 120 Mtr in stock, valued ₹24,000.");
  });

  test("vouchers by status: drafts only", async () => {
    const out = await ask("draft sales vouchers");
    expect(said(out)).toMatch(/INV\/0013/);
    expect(said(out)).not.toMatch(/INV\/0012/);
  });

  test("vouchers by party and month", async () => {
    const out = await ask("receipts from Gaurav Enterprises in June 2026");
    expect(said(out)).toMatch(/RCT\/0001/);
    expect(said(out)).not.toMatch(/PAY\/0001|INV\//);
  });

  test("a party nobody has is never dropped: nothing, not every receipt", async () => {
    const out = await ask("receipts from Nobody Traders");
    expect(out.state).toBe("no_match");
    expect(said(out)).not.toMatch(/RCT\/0001/);
  });

  test("a total is of posted vouchers, and says so", async () => {
    const out = await ask("total sales in June 2026");
    expect(rows(out)[0].title).toBe("Total of 1 posted sales voucher dated June 2026: ₹1,200.");
  });

  test("how many, and periods accountants say", async () => {
    expect(rows(await ask("how many vouchers"))[0].title).toBe("There are 5 vouchers.");
    expect(rows(await ask("payments last month"))[1].title).toBe("PAY/0001");
    expect(rows(await ask("how many journal vouchers this month"))[0].title).toBe("There is 1 journal voucher dated this month.");
    expect(said(await ask("pending approval jv"))).toMatch(/JV\/0001/);
  });

  test("a plural in the middle still names the type (found on the live books)", async () => {
    /* "sales vouchers this FY" was read as vouchers for a party called
       "sales": the plural sat on "vouchers", not the last word. */
    const out = await ask("sales vouchers in June 2026");
    expect(said(out)).toMatch(/INV\/0012/);
    expect(said(out)).not.toMatch(/RCT\/0001/);
    expect(rows(await ask("how many sales vouchers this FY"))[0].title).toBe("There are 2 sales vouchers dated this FY.");
  });

  test("'stock items' lists the family; it is not a stock figure for 'items'", async () => {
    const out = await ask("stock items");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Cotton Fabric/);
  });

  test("customers are the debtors, suppliers the creditors", async () => {
    const customers = said(await ask("customers"));
    expect(customers).toMatch(/Gaurav Enterprises/);
    expect(customers).not.toMatch(/Padma|Bank of Baroda/);
    expect(said(await ask("suppliers"))).toMatch(/Padma Traders/);
  });

  test("a list carries no cards; a record found by name does", async () => {
    const list = rows(await ask("sales vouchers"));
    expect(list.filter((r) => r.card)).toEqual([]);
    expect(rows(await ask("PI/0001"))[0].card.facts.find((f) => f.label === "Buyer").value).toBe("Gaurav Enterprises");
  });
});

describe("what it can never show", () => {
  test("a ledger's bank details, phone and email never leave the server", async () => {
    for (const query of ["Gaurav Enterprises", "balance of Gaurav Enterprises", "customers"]) {
      // eslint-disable-next-line no-await-in-loop
      const shown = JSON.stringify(await ask(query));
      expect(shown).not.toMatch(/999988887777|HDFC0001234|9876543210|gaurav@example\.com/);
    }
  });

  test("no company, no answer", async () => {
    expect((await service.search({ companyId: "", query: "INV/0012" })).state).toBe("unauthorised");
  });

  test("no model on this path, and the door is read-only", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "services", "ai", "accountingCommandSearch.service.js"), "utf8");
    expect(src).not.toMatch(/require\(["'][^"']*(qwen|ollama|gravAssistant|accountingTools)/i);
    /* accountingContext is used ONLY for the company-scoped balance. */
    expect(src).toMatch(/const \{ computeLedgerBalances \} = require\("\.\.\/accountingContext"\)/);
    const route = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "Accountant_Routes", "Acc_commandSearch.js"), "utf8");
    expect(route.match(/router\.(post|get|put|patch|delete)\(/g)).toEqual(["router.get("]);
    expect(route).toMatch(/accountantAuth, companyScope/);
  });
});

describe("a balance the books cannot vouch for says so", () => {
  /* The old Accounting dialog's one tested rule, moved to the server where
     the balance is computed: a ledger whose movements are one-sided with no
     opening balance (`source_incomplete`) shows "Needs reconciliation", never
     an amount. */
  test("the card and the answer both say 'needs reconciliation'", async () => {
    const mongoose = require("mongoose");
    const { A, ledgers } = books;
    const sales = await mongoose.connection.collection("acc_ledgers").findOne({ companyId: A, name: "Sales" });
    /* Revenue normally carries credits; one with only a debit and no opening
       is a ledger whose source is incomplete. */
    await mongoose.connection.collection("acc_vouchers").insertOne({
      companyId: A, voucherNumber: "JV/0099", voucherType: "journal", status: "posted", voucherDate: new Date("2026-07-01T06:00:00Z"),
      grandTotal: 10, ledgerEntries: [{ ledgerId: sales._id, type: "Dr", amount: 10, signedAmount: 10 }, { ledgerId: ledgers.bank._id, type: "Cr", amount: 10, signedAmount: -10 }],
    });
    await mongoose.connection.collection("acc_vouchers").updateMany({ companyId: A, "ledgerEntries.ledgerId": sales._id, voucherNumber: { $ne: "JV/0099" } }, { $set: { status: "draft" } });
    /* "Sales" lists the sales vouchers AND offers the ledger called Sales. */
    const card = rows(await ask("Sales")).find((r) => r.entityType === "ledger").card;
    expect(card.facts.find((f) => f.label === "Balance").value).toBe("Needs reconciliation");
    expect(rows(await ask("balance of Sales"))[0].title).toBe("Sales's balance needs reconciliation before it can be stated.");
  });
});
