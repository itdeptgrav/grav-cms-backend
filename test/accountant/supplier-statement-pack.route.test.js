// test/accountant/supplier-statement-pack.route.test.js
//
// Lane B, Chunk 5 — bulk SUPPLIER statement packs, over real collections.
//
// The customer pack and this one are the SAME code: one party-neutral
// assembly service, one set of writers, two thin routes. That is what stops
// the two sides drifting — and it is exactly why this file exists rather than
// being assumed from `customer-statement-pack.route.test.js`. Everything the
// party kind decides has to be asserted on the side it is easy to get wrong:
//
//   • The payable side. A supplier balance is a CREDIT; nothing in the pack
//     may flip, net or absolute it into a receivable.
//   • Supplier codes are `VEN-` + the id's last six hex characters — the code
//     the Suppliers screen shows. A pack that invented its own would name
//     parties by a code that appears nowhere else in the product.
//   • Every label an accountant reads says supplier: the scope line, the
//     refusals, the column heading, the filename.
//   • A CUSTOMER ledger cannot be pulled into a supplier pack by id.
//
// The structural claims — the pack equals the individual statement, scope
// rules, transports, container validity, no writes — are asserted here too,
// because "the customer suite covers it" is only true while both routes go on
// sharing an implementation, and a test suite should not depend on that.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => {
  const actual = jest.requireActual("../../Middlewear/AccountantOrgAuthMiddleware");
  return {
    ...actual,
    orgAuth: (req, res, next) => {
      const raw = req.headers["x-test-user"];
      if (!raw) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }
      const parsed = JSON.parse(raw);
      req.user = parsed.user;
      req.organization = parsed.organization || null;
      next();
    },
  };
});

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { readZip, zipMap, parseCsv } = require("./zipReader");

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/vendors/reports",
    require("../../routes/Accountant_Routes/Acc_vendorReports"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/vendors`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

async function seedCompany(name) {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2025-04-01"),
  });
  const creditors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Creditors",
    nature: "liability",
  });
  const debtors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const purchaseGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Purchase Accounts",
    nature: "expense",
  });
  const purchases = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Purchases`,
    groupId: purchaseGroup._id,
    groupName: purchaseGroup.name,
    nature: "expense",
  });
  return { company, creditors, debtors, purchaseGroup, purchases };
}

async function makeSupplier(fx, name, opts = {}) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: fx.creditors._id,
    groupName: fx.creditors.name,
    nature: "liability",
    gstin: opts.gstin || undefined,
    openingBalance: opts.openingBalance || 0,
    openingBalanceType: opts.openingBalanceType || "Cr",
  });
}

async function makeCustomer(fx, name) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: fx.debtors._id,
    groupName: fx.debtors.name,
    nature: "asset",
  });
}

/** One two-line voucher. Suppliers are credited by default — a purchase. */
async function postVoucher(fx, party, opts = {}) {
  const amount = opts.amount ?? 10000;
  const partySide = opts.partySide || "Cr";
  const otherSide = partySide === "Dr" ? "Cr" : "Dr";
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: opts.voucherType || "purchase",
    voucherNumber: opts.voucherNumber || `V-${Math.random().toString(36).slice(2, 9)}`,
    voucherDate: new Date(opts.date || "2026-05-01"),
    partyLedgerId: party._id,
    partyLedgerName: party.name,
    narration: opts.narration,
    status: opts.status || "posted",
    isOptional: opts.isOptional || false,
    grandTotal: amount,
    ledgerEntries: [
      { ledgerId: party._id, ledgerName: party.name, type: partySide, amount },
      { ledgerId: fx.purchases._id, ledgerName: fx.purchases.name, type: otherSide, amount },
    ],
  });
}

const orgFor = (company, role = "owner") => ({
  user: {
    id: new mongoose.Types.ObjectId().toString(),
    role,
    permissions: { canView: true, canEdit: true },
  },
  organization: { tallyCompanyIds: [String(company._id)] },
});

async function call(path, { user, raw = false, method = "GET", body: reqBody } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user === null ? {} : { "x-test-user": JSON.stringify(user) }),
      ...(reqBody !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(reqBody !== undefined ? { body: JSON.stringify(reqBody) } : {}),
  });
  if (raw) return res;
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const packUrl = (companyId, extra = "") =>
  `/reports/statement-pack?companyId=${companyId}${extra}`;

const bytesOf = async (res) => Buffer.from(await res.arrayBuffer());

/** Three suppliers, deliberately mirroring the customer suite with the sides
 *  swapped, so a sign that leaks between the two kinds shows up as a wrong
 *  Dr/Cr rather than as a plausible number. */
async function seedThreeSuppliers() {
  const fx = await seedCompany("Alpha Metals");
  const acme = await makeSupplier(fx, "Acme Steel", {
    openingBalance: 5000,
    openingBalanceType: "Cr",
    gstin: "27BBBBB1111B1Z4",
  });
  const bharat = await makeSupplier(fx, "Bharat Castings", {
    openingBalance: 2000,
    openingBalanceType: "Dr",
  });
  const zeta = await makeSupplier(fx, "Zeta Packaging");

  await postVoucher(fx, acme, { amount: 12000, date: "2026-05-04", voucherNumber: "P-1" });
  await postVoucher(fx, acme, {
    amount: 4000,
    date: "2026-05-20",
    partySide: "Dr",
    voucherNumber: "PAY-1",
  });
  await postVoucher(fx, bharat, { amount: 7500, date: "2026-05-11", voucherNumber: "P-2" });

  return { fx, acme, bharat, zeta };
}

/* ── Company scope must be present and honest ────────────────────────────── */

describe("company scope — fail closed", () => {
  test("no companyId is a 400, not an unscoped pack of every company", async () => {
    const fx = await seedCompany("A");
    const r = await call("/reports/statement-pack", { user: orgFor(fx.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("no credentials at all is a 401", async () => {
    const fx = await seedCompany("A");
    const r = await call(packUrl(fx.company._id), { user: null });
    expect(r.status).toBe(401);
  });

  test("a company the organisation does not own is refused by Lane A's check", async () => {
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    const r = await call(packUrl(b.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(403);
  });

  test("companyId in the query and a DIFFERENT one in the body is refused outright", async () => {
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    const r = await call(packUrl(a.company._id), {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("a nonexistent but well-formed companyId is a 404, not an empty success", async () => {
    const ghost = new mongoose.Types.ObjectId();
    const r = await call(packUrl(ghost), {
      user: {
        user: { id: "u", role: "owner" },
        organization: { tallyCompanyIds: [String(ghost)] },
      },
    });
    expect(r.status).toBe(404);
  });
});

/* ── The payable side survives the pack ──────────────────────────────────── */

describe("a supplier balance stays a CREDIT", () => {
  test("opening, movement and closing are all on the payable side", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    expect(r.status).toBe(200);
    const [acme, bharat, zeta] = r.body.pack.statements;

    // 5,000 Cr opening + 12,000 Cr purchase − 4,000 Dr payment = 13,000 Cr.
    expect(acme.opening).toMatchObject({ amount: 5000, type: "Cr", signed: -5000 });
    expect(acme.totals).toMatchObject({ debit: 4000, credit: 12000, transactionCount: 2 });
    expect(acme.closing).toMatchObject({ amount: 13000, type: "Cr", signed: -13000 });

    // An ADVANCE paid to a supplier is a debit opening, and stays one.
    expect(bharat.opening).toMatchObject({ amount: 2000, type: "Dr", signed: 2000 });
    expect(bharat.closing).toMatchObject({ amount: 5500, type: "Cr" });

    expect(zeta.closing).toMatchObject({ amount: 0, type: "Cr" });
  });

  test("the pack's own totals keep debit and credit apart — nothing is netted", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    const p = r.body.pack;
    expect(p.totals.debit).toBe(4000);
    expect(p.totals.credit).toBe(19500);
    expect(p.totals.partyCount).toBe(3);
    expect(p.totals.partiesWithMovement).toBe(2);
    // Signed sums: 5,000 Cr + 2,000 Dr opening = 3,000 Cr overall.
    expect(p.totals.openingSigned).toBe(-3000);
    expect(p.totals.closingSigned).toBe(-18500);
  });

  test("a running balance that crosses zero is reported on the side it lands", async () => {
    const fx = await seedCompany("Cross Ltd");
    const supp = await makeSupplier(fx, "Overpaid Supplier", {
      openingBalance: 1000,
      openingBalanceType: "Cr",
    });
    await postVoucher(fx, supp, { amount: 5000, date: "2026-06-05", partySide: "Dr" });
    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    const s = r.body.pack.statements[0];
    // Paid 5,000 against 1,000 owed — the supplier now holds 4,000 of ours.
    expect(s.closing).toMatchObject({ amount: 4000, type: "Dr" });
    expect(s.rows[0].runningType).toBe("Dr");
  });
});

/* ── THE CENTRAL CLAIM: the pack is not a second calculation ─────────────── */

describe("every statement in the pack equals the individual statement export", () => {
  async function bothWays(fx, ledger, user, period = "") {
    const pack = await call(packUrl(fx.company._id, period), { user });
    const single = await call(
      `/reports/ledger/${ledger._id}?companyId=${fx.company._id}${period}`,
      { user },
    );
    expect(pack.status).toBe(200);
    expect(single.status).toBe(200);
    const entry = pack.body.pack.statements.find(
      (s) => s.ledger.ledgerId === String(ledger._id),
    );
    expect(entry).toBeTruthy();
    return { entry, statement: single.body.statement };
  }

  test("opening, closing, totals and every row match, for a party with movement", async () => {
    const { fx, acme } = await seedThreeSuppliers();
    const { entry, statement } = await bothWays(fx, acme, orgFor(fx.company));
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.closing).toEqual(statement.closing);
    expect(entry.totals).toEqual(statement.totals);
    expect(entry.ledger).toEqual(statement.ledger);
    expect(entry.rows).toEqual(statement.rows);
  });

  test("it matches for a DEBIT (advance) opening", async () => {
    const { fx, bharat } = await seedThreeSuppliers();
    const { entry, statement } = await bothWays(fx, bharat, orgFor(fx.company));
    expect(entry.opening.type).toBe("Dr");
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.closing).toEqual(statement.closing);
  });

  test("it matches over a DATE RANGE, opening balance and its sign included", async () => {
    const { fx, acme } = await seedThreeSuppliers();
    const { entry, statement } = await bothWays(
      fx,
      acme,
      orgFor(fx.company),
      "&from=2026-05-10&to=2026-05-31",
    );
    // The 4 May purchase is before the window, so it is in the opening — as a
    // credit, which is a NEGATIVE signed prior movement.
    expect(statement.opening.priorMovement).toBe(-12000);
    expect(statement.opening.type).toBe("Cr");
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.rows).toEqual(statement.rows);
    expect(entry.totals).toEqual(statement.totals);
  });

  test("it matches for a party with NO movement", async () => {
    const { fx, zeta } = await seedThreeSuppliers();
    const { entry, statement } = await bothWays(fx, zeta, orgFor(fx.company));
    expect(entry.rows).toEqual([]);
    expect(entry.opening).toEqual(statement.opening);
    expect(entry.closing).toEqual(statement.closing);
  });
});

/* ── Company and party-kind isolation ────────────────────────────────────── */

describe("isolation", () => {
  test("Company A's pack contains no Company B party and no Company B amount", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSupp = await makeSupplier(a, "Alpha Vendor");
    const bSupp = await makeSupplier(b, "Beta Vendor");
    await postVoucher(a, aSupp, { amount: 11000 });
    await postVoucher(b, bSupp, { amount: 99999 });

    const r = await call(packUrl(a.company._id), { user: orgFor(a.company) });
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Vendor"]);
    expect(JSON.stringify(r.body)).not.toContain("Beta Vendor");
    expect(JSON.stringify(r.body)).not.toContain("99999");
  });

  test("a SPOOFED selected ledger id from another company is excluded, not stated", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSupp = await makeSupplier(a, "Alpha Vendor");
    const bSupp = await makeSupplier(b, "Beta Vendor");
    await postVoucher(a, aSupp, { amount: 11000 });
    await postVoucher(b, bSupp, { amount: 99999 });

    const r = await call(
      packUrl(a.company._id, `&scope=selected&ledgerIds=${aSupp._id},${bSupp._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Vendor"]);
  });

  test("A CUSTOMER LEDGER CANNOT BE PULLED INTO A SUPPLIER PACK BY ID", async () => {
    /* The mirror of the customer suite's assertion, and the one that matters
       most here: both packs run the same party-neutral service, so the only
       thing keeping a debtor out is the Sundry Creditors re-resolution. */
    const fx = await seedCompany("Alpha");
    const supp = await makeSupplier(fx, "Alpha Vendor");
    const cust = await makeCustomer(fx, "Alpha Buyer");
    await postVoucher(fx, supp, { amount: 11000 });
    await postVoucher(fx, cust, { amount: 4000, partySide: "Dr" });

    const all = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    expect(all.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Vendor"]);

    const picked = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${cust._id}`),
      { user: orgFor(fx.company) },
    );
    expect(picked.status).toBe(200);
    expect(picked.body.pack.statements).toEqual([]);
  });
});

/* ── Supplier vocabulary and supplier codes ──────────────────────────────── */

describe("it speaks about suppliers, and names them the way the product does", () => {
  test("party codes are VEN- plus the id's last six hex characters", async () => {
    /* The code on the Suppliers screen. A pack that minted its own — the
       customer `C-` base36 form, say — would label parties by a code that
       appears nowhere else, and reconciling a statement against the screen
       would mean matching on name alone. */
    const { fx, acme } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    const entry = r.body.pack.statements.find((s) => s.ledger.name === "Acme Steel");
    expect(entry.ledger.code).toBe(`VEN-${String(acme._id).slice(-6).toUpperCase()}`);
    for (const s of r.body.pack.statements) {
      expect(s.ledger.code).toMatch(/^VEN-[0-9A-F]{6}$/);
    }
  });

  test("the scope line and the refusals say supplier, not customer", async () => {
    const { fx, acme } = await seedThreeSuppliers();
    const user = orgFor(fx.company);

    const all = await call(packUrl(fx.company._id, "&scope=all"), { user });
    expect(all.body.pack.scopeSummary).toBe("Scope: all accounting suppliers (3)");

    const selected = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${acme._id}`),
      { user },
    );
    expect(selected.body.pack.scopeSummary).toBe("Scope: selected suppliers (1)");

    const none = await call(packUrl(fx.company._id, "&scope=selected&ledgerIds="), { user });
    expect(none.status).toBe(400);
    expect(none.body.message).toMatch(/select at least one supplier/i);
    expect(none.body.message).not.toMatch(/customer/i);
  });

  test("the pack labels itself a supplier pack", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    expect(r.body.pack.partyKind).toBe("supplier");
    expect(r.body.pack.reportType).toBe("supplier-statement-pack");
    expect(r.body.pack.title).toBe("Supplier Statement Pack");
    expect(r.body.pack.labels).toMatchObject({
      party: "supplier",
      partyPlural: "suppliers",
      column: "Supplier",
      group: "Sundry Creditors",
      filenameStem: "supplier-statements",
      primarySide: "Cr",
    });
  });

  test("the workbook's party column is headed Supplier and the file is named one", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(packUrl(fx.company._id, "&format=xlsx&asOf=2026-05-31"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-metals-supplier-statements-as-on-2026-05-31.xlsx",
    );
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(res));
    expect(wb.getWorksheet("Summary").getRow(7).values.slice(1)[1]).toBe("Supplier");
    expect(wb.getWorksheet("Transactions").getRow(7).values.slice(1)[1]).toBe("Supplier");
    const head = JSON.stringify(wb.getWorksheet("Summary").getRows(1, 6).map((r) => r.values));
    expect(head).toContain("Scope: all accounting suppliers");
    expect(head).not.toContain("customer");
  });
});

/* ── Scope rules ─────────────────────────────────────────────────────────── */

describe("scope", () => {
  test("scope=all states every supplier, in name order", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id, "&scope=all"), { user: orgFor(fx.company) });
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual([
      "Acme Steel",
      "Bharat Castings",
      "Zeta Packaging",
    ]);
  });

  test("scope=selected and scope=filtered state EXACTLY the ids given", async () => {
    const { fx, acme, zeta } = await seedThreeSuppliers();
    const user = orgFor(fx.company);
    const selected = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${acme._id},${zeta._id}`),
      { user },
    );
    expect(selected.body.pack.statements.map((s) => s.ledger.name)).toEqual([
      "Acme Steel",
      "Zeta Packaging",
    ]);
    const filtered = await call(
      packUrl(fx.company._id, `&scope=filtered&ledgerIds=${zeta._id}`),
      { user },
    );
    expect(filtered.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Zeta Packaging"]);
    expect(filtered.body.pack.scopeSummary).toBe("Scope: current filtered result (1)");
  });

  test("AN EMPTY FILTERED RESULT STAYS EMPTY — it never widens to every supplier", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id, "&scope=filtered&ledgerIds="), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.pack.statements).toEqual([]);
    expect(r.body.pack.resolvedLedgerCount).toBe(0);
  });

  test("scope=filtered with the parameter ABSENT is a refusal, not a full pack", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id, "&scope=filtered"), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/must send the ledger ids/i);
  });
});

/* ── The period bounds the whole pack ────────────────────────────────────── */

describe("period", () => {
  test("from/to are inclusive at both ends and exclude what is outside", async () => {
    const fx = await seedCompany("Alpha");
    const supp = await makeSupplier(fx, "Bounded Vendor");
    await postVoucher(fx, supp, { amount: 1000, date: "2026-05-31", voucherNumber: "BEFORE" });
    await postVoucher(fx, supp, { amount: 2000, date: "2026-06-01", voucherNumber: "FIRST" });
    await postVoucher(fx, supp, { amount: 4000, date: "2026-06-30", voucherNumber: "LAST" });
    await postVoucher(fx, supp, { amount: 8000, date: "2026-07-01", voucherNumber: "AFTER" });

    const r = await call(packUrl(fx.company._id, "&from=2026-06-01&to=2026-06-30"), {
      user: orgFor(fx.company),
    });
    const s = r.body.pack.statements[0];
    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["FIRST", "LAST"]);
    expect(s.totals.credit).toBe(6000);
    expect(s.opening).toMatchObject({ amount: 1000, type: "Cr", priorMovement: -1000 });
    expect(s.closing).toMatchObject({ amount: 7000, type: "Cr" });
  });

  test("asOf bounds the pack and the later voucher is absent entirely", async () => {
    const fx = await seedCompany("Alpha");
    const supp = await makeSupplier(fx, "As-On Vendor");
    await postVoucher(fx, supp, { amount: 3000, date: "2026-06-10", voucherNumber: "IN" });
    await postVoucher(fx, supp, { amount: 9000, date: "2026-07-10", voucherNumber: "OUT" });

    const r = await call(packUrl(fx.company._id, "&asOf=2026-06-30"), {
      user: orgFor(fx.company),
    });
    const s = r.body.pack.statements[0];
    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["IN"]);
    expect(s.closing).toMatchObject({ amount: 3000, type: "Cr" });
    expect(JSON.stringify(r.body)).not.toContain("9000");
  });

  test("draft and optional vouchers are in no pack, at any period", async () => {
    const fx = await seedCompany("Alpha");
    const supp = await makeSupplier(fx, "Clean Vendor");
    await postVoucher(fx, supp, { amount: 5000, date: "2026-06-10", voucherNumber: "REAL" });
    await postVoucher(fx, supp, {
      amount: 70000,
      date: "2026-06-11",
      voucherNumber: "DRAFT",
      status: "draft",
    });
    await postVoucher(fx, supp, {
      amount: 80000,
      date: "2026-06-12",
      voucherNumber: "OPTIONAL",
      isOptional: true,
    });

    const r = await call(packUrl(fx.company._id), { user: orgFor(fx.company) });
    expect(r.body.pack.statements[0].rows.map((x) => x.voucherNumber)).toEqual(["REAL"]);
    expect(JSON.stringify(r.body)).not.toContain("70000");
    expect(JSON.stringify(r.body)).not.toContain("80000");
  });
});

/* ── One request, two transports ─────────────────────────────────────────── */

describe("GET and POST are the same request", () => {
  test("a selection sent in the body gives the identical pack to the same ids in the query", async () => {
    const { fx, acme, bharat } = await seedThreeSuppliers();
    const user = orgFor(fx.company);
    const ids = [String(acme._id), String(bharat._id)];

    const viaGet = await call(
      packUrl(fx.company._id, `&scope=selected&ledgerIds=${ids.join(",")}&from=2026-05-01&to=2026-05-31`),
      { user },
    );
    const viaPost = await call(packUrl(fx.company._id), {
      user,
      method: "POST",
      body: { scope: "selected", ledgerIds: ids, from: "2026-05-01", to: "2026-05-31" },
    });

    expect(viaGet.status).toBe(200);
    expect(viaPost.status).toBe(200);
    const strip = (p) =>
      JSON.parse(
        JSON.stringify(p, (k, v) => (k === "generatedAt" || k === "filters" ? null : v)),
      );
    expect(strip(viaPost.body.pack)).toEqual(strip(viaGet.body.pack));
  });

  test("a POST body's ids are re-resolved in the company, not trusted", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSupp = await makeSupplier(a, "Alpha Vendor");
    const bSupp = await makeSupplier(b, "Beta Vendor");
    const r = await call(packUrl(a.company._id), {
      user: orgFor(a.company),
      method: "POST",
      body: { scope: "selected", ledgerIds: [String(aSupp._id), String(bSupp._id)] },
    });
    expect(r.body.pack.statements.map((s) => s.ledger.name)).toEqual(["Alpha Vendor"]);
  });
});

/* ── The containers ──────────────────────────────────────────────────────── */

describe("format=xlsx", () => {
  test("two sheets, one row per supplier, payable amounts on the credit side", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(packUrl(fx.company._id, "&format=xlsx"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(res));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Transactions"]);

    const ws = wb.getWorksheet("Summary");
    const acme = ws.getRow(8).values.slice(1);
    expect(acme[1]).toBe("Acme Steel");
    expect(acme[3]).toBe(5000);
    expect(acme[4]).toBe("Cr");
    expect(acme[5]).toBe(4000); // debit: the payment
    expect(acme[6]).toBe(12000); // credit: the purchase
    expect(acme[7]).toBe(13000);
    expect(acme[8]).toBe("Cr");
    expect(acme[9]).toBe(2);
    for (const col of [4, 6, 7, 8]) expect(typeof ws.getRow(8).getCell(col).value).toBe("number");

    const total = ws.getRow(11);
    expect(total.getCell(1).value).toBe("TOTAL");
    expect(total.getCell(6).value).toBe(4000);
    expect(total.getCell(7).value).toBe(19500);
  });

  test("Transactions bands each supplier's postings between its opening and closing", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(packUrl(fx.company._id, "&format=xlsx"), {
      user: orgFor(fx.company),
      raw: true,
    });
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(res));
    const ws = wb.getWorksheet("Transactions");
    const read = (r) => ws.getRow(r).values.slice(1);
    expect(read(8)[1]).toBe("Acme Steel");
    expect(read(8)[5]).toBe("Opening Balance");
    expect(read(8)[8]).toBe(5000);
    expect(read(8)[9]).toBe("Cr");
    expect(read(9)[4]).toBe("P-1");
    expect(read(9)[7]).toBe(12000); // credit column
    expect(read(10)[4]).toBe("PAY-1");
    expect(read(10)[6]).toBe(4000); // debit column
    expect(read(11)[5]).toBe("Closing Balance");
    expect(read(11)[8]).toBe(13000);
    expect(read(11)[9]).toBe("Cr");
  });
});

describe("format=pdf", () => {
  const pageCount = (buf) =>
    (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

  test("a real PDF, one page per supplier and no blank pages after them", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(packUrl(fx.company._id, "&format=pdf"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = await bytesOf(res);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(buf)).toBe(3);
  });

  test("an empty filtered scope produces a one-page PDF that says so", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(
      packUrl(fx.company._id, "&format=pdf&scope=filtered&ledgerIds="),
      { user: orgFor(fx.company), raw: true },
    );
    const buf = await bytesOf(res);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(buf)).toBe(1);
  });
});

describe("format=zip", () => {
  test("one PDF per supplier plus a manifest, and every entry parses", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(packUrl(fx.company._id, "&format=zip"), {
      user: orgFor(fx.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe("application/zip");
    const entries = readZip(await bytesOf(res));
    expect(entries[0].name).toBe("manifest.csv");
    const pdfs = entries.filter((e) => e.name.endsWith(".pdf"));
    expect(pdfs).toHaveLength(3);
    for (const e of pdfs) expect(e.data.slice(0, 5).toString()).toBe("%PDF-");
  });

  test("the manifest carries each supplier's own balances, on the payable side", async () => {
    const { fx } = await seedThreeSuppliers();
    const res = await call(packUrl(fx.company._id, "&format=zip&from=2026-05-01&to=2026-05-31"), {
      user: orgFor(fx.company),
      raw: true,
    });
    const buf = await bytesOf(res);
    const rows = parseCsv(zipMap(buf)["manifest.csv"].toString("utf8"));
    const acme = rows.find((r) => r[2] === "Acme Steel");
    expect(acme[0]).toBe("Alpha Metals");
    expect(acme[1]).toMatch(/^VEN-[0-9A-F]{6}$/);
    expect(acme[3]).toBe("27BBBBB1111B1Z4");
    expect(acme[4]).toBe("2026-05-01 to 2026-05-31");
    expect(acme[5]).toBe("5000");
    expect(acme[6]).toBe("Cr");
    expect(acme[7]).toBe("13000");
    expect(acme[8]).toBe("Cr");
    expect(acme[9]).toBe("4000");
    expect(acme[10]).toBe("12000");

    const names = new Set(readZip(buf).map((e) => e.name));
    for (const r of rows.slice(1)) expect(names.has(r[12])).toBe(true);
  });

  test("suppliers whose names slug alike get distinct files, not one overwritten", async () => {
    const fx = await seedCompany("Dup Metals");
    const one = await makeSupplier(fx, "Acme Steel");
    const two = await makeSupplier(fx, "ACME STEEL");
    const three = await makeSupplier(fx, "Acme & Steel");
    await postVoucher(fx, one, { amount: 100 });
    await postVoucher(fx, two, { amount: 200 });
    await postVoucher(fx, three, { amount: 300 });

    const res = await call(packUrl(fx.company._id, "&format=zip"), {
      user: orgFor(fx.company),
      raw: true,
    });
    const buf = await bytesOf(res);
    const pdfs = readZip(buf).filter((e) => e.name.endsWith(".pdf"));
    expect(pdfs).toHaveLength(3);
    expect(new Set(pdfs.map((e) => e.name)).size).toBe(3);
    const rows = parseCsv(zipMap(buf)["manifest.csv"].toString("utf8")).slice(1);
    expect(rows.map((r) => r[12]).sort()).toEqual(pdfs.map((e) => e.name).sort());
    // The repeats carry their own VEN- code, so which is which is readable.
    expect(rows.filter((r) => r[12].includes(r[1].toLowerCase()))).toHaveLength(2);
  });
});

/* ── Limits, and writing nothing ─────────────────────────────────────────── */

describe("request validation", () => {
  test("an unknown format is refused rather than defaulted", async () => {
    const { fx } = await seedThreeSuppliers();
    const r = await call(packUrl(fx.company._id, "&format=docx"), {
      user: orgFor(fx.company),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/xlsx.*pdf.*zip/i);
  });

  test("an id list longer than the cap is refused before any statement is built", async () => {
    const { fx } = await seedThreeSuppliers();
    const tooMany = Array.from({ length: 2001 }, () => new mongoose.Types.ObjectId().toString());
    const r = await call(packUrl(fx.company._id), {
      user: orgFor(fx.company),
      method: "POST",
      body: { scope: "selected", ledgerIds: tooMany },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/At most 2000 ledgers/i);
  });

  test("GENERATING A PACK IN EVERY FORMAT WRITES NOTHING", async () => {
    const { fx, acme, bharat, zeta } = await seedThreeSuppliers();
    const user = orgFor(fx.company);
    const snapshot = async () => ({
      vouchers: await Acc_Voucher.countDocuments({}),
      ledgers: await Acc_Ledger.countDocuments({}),
      companies: await Acc_Company.countDocuments({}),
      stamps: await Promise.all(
        [acme, bharat, zeta].map(async (l) => {
          const d = await Acc_Ledger.findById(l._id).lean();
          return `${d.updatedAt}|${d.openingBalance}|${d.openingBalanceType}`;
        }),
      ),
      voucherStamps: (await Acc_Voucher.find({ companyId: fx.company._id }).lean())
        .map((v) => `${v._id}|${v.status}|${v.updatedAt}`)
        .sort(),
    });

    const before = await snapshot();
    for (const f of ["json", "xlsx", "pdf", "zip"]) {
      const res = await call(packUrl(fx.company._id, `&format=${f}`), { user, raw: true });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    expect(await snapshot()).toEqual(before);
  });
});
