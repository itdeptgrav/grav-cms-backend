// test/accountant/customer-outstanding.route.test.js
//
// Lane B, Chunk 1 — Customer Outstanding Summary and individual Customer
// Ledger exports, over real collections.
//
// What this file exists to prove that the pure tests cannot:
//   • Company A's export never contains Company B's ledgers or vouchers —
//     including when Company B's ledger id is handed in as a "selection".
//   • Only POSTED, non-OPTIONAL vouchers dated on or before `asOf` are counted.
//   • The opening balance is real, and on a date-range statement it includes
//     the movement BEFORE `from` instead of silently omitting it.
//   • CRM quotations and Customer Requests — the other, non-accounting notion
//     of "outstanding" living in Acc_customers.js — cannot move these figures.
//   • The Excel amount cells hold NUMBERS, and the totals are right.
//   • Content types and filenames are correct and safe.
//   • The existing Customer Master export still works.
//
// `orgAuth` is mocked so identity is assertable per request without a JWT —
// it is Lane A's, and this suite is not testing it. `requireCompanyAccess` is
// the REAL one, because whether a report can be pulled for a company the
// organisation does not own is precisely a Lane B concern.
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
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/customers/reports",
    require("../../routes/Accountant_Routes/Acc_customerReports"),
  );
  app.use("/api/accountant/customers", require("../../routes/Accountant_Routes/Acc_customers"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/customers`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

/**
 * A company with a Sundry Debtors tree, a sales ledger and a bank ledger.
 * Groups are nested one level deep on purpose: sub-grouped debtors are normal
 * in Tally and a report that only matched the exact group name would omit them.
 */
async function seedCompany(name) {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2025-04-01"),
  });
  const debtors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const domestic = await Acc_Group.create({
    companyId: company._id,
    name: "Domestic Buyers",
    parent: debtors._id,
    parentName: debtors.name,
    nature: "asset",
  });
  const creditors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Creditors",
    nature: "liability",
  });
  const salesGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Sales Accounts",
    nature: "revenue",
  });
  const sales = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Sales`,
    groupId: salesGroup._id,
    groupName: salesGroup.name,
    nature: "revenue",
  });
  return { company, debtors, domestic, creditors, salesGroup, sales };
}

async function makeCustomer(fx, name, opts = {}) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: opts.group ? opts.group._id : fx.debtors._id,
    groupName: opts.group ? opts.group.name : fx.debtors.name,
    nature: "asset",
    gstin: opts.gstin || undefined,
    // Party contact details live under `contactDetails` on Acc_Ledger — and
    // NOT in the fields this service searches, which is the whole point of the
    // screen-vs-export divergence tests below.
    ...(opts.email || opts.phone
      ? { contactDetails: { email: opts.email, phone: opts.phone } }
      : {}),
    openingBalance: opts.openingBalance || 0,
    openingBalanceType: opts.openingBalanceType || "Dr",
  });
}

/** One two-line voucher: `amount` Dr on the party, Cr on the sales ledger. */
async function postVoucher(fx, party, opts = {}) {
  const amount = opts.amount ?? 10000;
  const partySide = opts.partySide || "Dr";
  const otherSide = partySide === "Dr" ? "Cr" : "Dr";
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: opts.voucherType || "sales",
    voucherTypeName: opts.voucherTypeName,
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
      { ledgerId: fx.sales._id, ledgerName: fx.sales.name, type: otherSide, amount },
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

/**
 * One request via node:http, which — unlike `fetch` — will put a body on a
 * GET. Used to reach the guard the way a non-browser client could.
 */
function rawRequest({ method = "GET", path, user, body }) {
  const http = require("http");
  const payload = body === undefined ? null : JSON.stringify(body);
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: `/api/accountant/customers${path}`,
        headers: {
          ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const q = (companyId, extra = "") =>
  `/reports/outstanding?companyId=${companyId}${extra}`;

/* ── Scope must be present and honest ────────────────────────────────────── */

describe("company scope — fail closed", () => {
  test("no companyId is a 400, not an unscoped read", async () => {
    const fx = await seedCompany("A");
    const r = await call("/reports/outstanding", { user: orgFor(fx.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("a malformed companyId is a 400", async () => {
    const fx = await seedCompany("A");
    const r = await call(q("not-an-object-id"), { user: orgFor(fx.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("no credentials at all is a 401", async () => {
    const fx = await seedCompany("A");
    const r = await call(q(fx.company._id), { user: null });
    expect(r.status).toBe(401);
  });

  test("a company the organisation does not own is refused by Lane A's check", async () => {
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    const r = await call(q(b.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(403);
  });

  test("a nonexistent but well-formed companyId is a 404, not an empty success", async () => {
    const ghost = new mongoose.Types.ObjectId();
    const r = await call(q(ghost), {
      user: { user: { id: "u", role: "owner" }, organization: { tallyCompanyIds: [String(ghost)] } },
    });
    expect(r.status).toBe(404);
  });
});

/* ── Company isolation ───────────────────────────────────────────────────── */

describe("company isolation", () => {
  test("Company A's report contains no Company B ledger and no Company B voucher", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(a, aCust, { amount: 11000 });
    await postVoucher(b, bCust, { amount: 99999 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    const names = r.body.report.rows.map((x) => x.name);
    expect(names).toEqual(["Alpha Buyer"]);
    expect(r.body.report.totals.receivable).toBe(11000);
    expect(JSON.stringify(r.body)).not.toContain("Beta Buyer");
    expect(JSON.stringify(r.body)).not.toContain("99999");
  });

  test("a SPOOFED selected ledger id from another company is excluded, not exported", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(a, aCust, { amount: 11000 });
    await postVoucher(b, bCust, { amount: 99999 });

    const r = await call(
      q(a.company._id, `&scope=selected&ledgerIds=${aCust._id},${bCust._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.status).toBe(200);
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Alpha Buyer"]);
    expect(r.body.report.totals.receivable).toBe(11000);
  });

  test("a selection consisting ONLY of another company's ledgers returns nothing — never everything", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));
    const bCust = await makeCustomer(b, "Beta Buyer");

    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${bCust._id}`), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.totals.receivable).toBe(0);
  });

  test("a ledger outside Sundry Debtors cannot be pulled into a customer report by id", async () => {
    const a = await seedCompany("Alpha");
    const supplier = await Acc_Ledger.create({
      companyId: a.company._id,
      name: "Alpha Supplier",
      groupId: a.creditors._id,
      groupName: a.creditors.name,
      nature: "liability",
    });
    await postVoucher(a, supplier, { amount: 4000, partySide: "Cr" });

    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${supplier._id}`), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
  });

  test("an individual statement for another company's ledger is a 404", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(b, bCust, { amount: 99999 });

    const r = await call(`/reports/ledger/${bCust._id}?companyId=${a.company._id}`, {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(404);
  });
});

/* ── Which vouchers count ────────────────────────────────────────────────── */

describe("only posted, non-optional vouchers through the as-of date", () => {
  test("drafts, pending approvals, cancellations, voids and optionals are all excluded", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 10000 }); // counted
    await postVoucher(a, cust, { amount: 500, status: "draft" });
    await postVoucher(a, cust, { amount: 600, status: "pending_approval" });
    await postVoucher(a, cust, { amount: 700, status: "cancelled" });
    await postVoucher(a, cust, { amount: 800, status: "void" });
    await postVoucher(a, cust, { amount: 900, isOptional: true });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.balance).toBe(10000);
    expect(row.balanceType).toBe("Dr");
    expect(row.transactionCount).toBe(1);
  });

  test("a voucher dated AFTER the as-of date is not in an as-of report", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 10000, date: "2026-05-01" });
    await postVoucher(a, cust, { amount: 25000, date: "2026-07-15" });

    const asAt = await call(q(a.company._id, "&asOf=2026-06-30"), { user: orgFor(a.company) });
    expect(asAt.body.report.rows[0].balance).toBe(10000);

    const today = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(today.body.report.rows[0].balance).toBe(35000);
  });

  test("a voucher dated ON the as-of date IS included", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 10000, date: "2026-06-30" });

    const r = await call(q(a.company._id, "&asOf=2026-06-30"), { user: orgFor(a.company) });
    expect(r.body.report.rows[0].balance).toBe(10000);
  });

  test("a voucher touching the party twice is ONE transaction, not two", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await Acc_Voucher.create({
      companyId: a.company._id,
      voucherType: "journal",
      voucherNumber: "JV-1",
      voucherDate: new Date("2026-05-01"),
      status: "posted",
      grandTotal: 3000,
      ledgerEntries: [
        { ledgerId: cust._id, ledgerName: cust.name, type: "Dr", amount: 5000 },
        { ledgerId: cust._id, ledgerName: cust.name, type: "Cr", amount: 2000 },
        { ledgerId: a.sales._id, ledgerName: a.sales.name, type: "Cr", amount: 3000 },
      ],
    });
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.debit).toBe(5000);
    expect(row.credit).toBe(2000);
    expect(row.balance).toBe(3000);
    expect(row.transactionCount).toBe(1);
  });
});

/* ── Opening balance and signs ───────────────────────────────────────────── */

describe("opening balance and debit/credit signs", () => {
  test("the ledger opening balance is included in the outstanding figure", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer", {
      openingBalance: 15000,
      openingBalanceType: "Dr",
    });
    await postVoucher(a, cust, { amount: 5000 });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.openingBalance).toBe(15000);
    expect(row.openingType).toBe("Dr");
    expect(row.balance).toBe(20000);
  });

  test("a Cr opening balance reduces the receivable and can flip it to a credit", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Advance Holder", {
      openingBalance: 30000,
      openingBalanceType: "Cr",
    });
    await postVoucher(a, cust, { amount: 5000 });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.balanceType).toBe("Cr");
    expect(row.balance).toBe(25000);
    expect(row.receivable).toBe(0);
    expect(row.customerCredit).toBe(25000);
  });

  test("a customer in credit is not added to the receivable total", async () => {
    const a = await seedCompany("Alpha");
    const owing = await makeCustomer(a, "Owes Us");
    const credit = await makeCustomer(a, "In Credit");
    await postVoucher(a, owing, { amount: 100000 });
    await postVoucher(a, credit, { amount: 40000, partySide: "Cr", voucherType: "receipt" });

    const totals = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.totals;
    expect(totals.receivable).toBe(100000);
    expect(totals.customerCredit).toBe(40000);
    expect(totals.netBalance).toBe(60000);
    expect(totals.debtorCount).toBe(1);
    expect(totals.creditCount).toBe(1);
  });
});

/* ── Scopes ──────────────────────────────────────────────────────────────── */

describe("all / filtered / selected scopes", () => {
  async function threeCustomers() {
    const a = await seedCompany("Alpha");
    const big = await makeCustomer(a, "Big Buyer Pvt Ltd", { gstin: "27AAAAA0000A1Z5" });
    // A sub-grouped debtor, to prove the group walk reaches descendants.
    const small = await makeCustomer(a, "Small Buyer LLP", { group: a.domestic });
    const quiet = await makeCustomer(a, "Quiet Buyer");
    await postVoucher(a, big, { amount: 100000 });
    await postVoucher(a, small, { amount: 900 });
    return { a, big, small, quiet };
  }

  test("all returns every customer ledger with a balance, including sub-grouped ones", async () => {
    const { a } = await threeCustomers();
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name).sort()).toEqual([
      "Big Buyer Pvt Ltd",
      "Small Buyer LLP",
    ]);
    // The zero-balance ledger was considered and filtered, not missed.
    expect(r.body.report.consideredLedgerCount).toBe(3);
  });

  test("server-side search narrows the `all` scope by name", async () => {
    const { a } = await threeCustomers();
    const r = await call(q(a.company._id, "&search=small"), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Small Buyer LLP"]);
  });

  test("server-side search matches GSTIN too", async () => {
    const { a } = await threeCustomers();
    const r = await call(q(a.company._id, "&search=27AAAAA0000A1Z5"), {
      user: orgFor(a.company),
    });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Big Buyer Pvt Ltd"]);
  });

  test("selected returns exactly the chosen ledgers", async () => {
    const { a, small } = await threeCustomers();
    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${small._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Small Buyer LLP"]);
    expect(r.body.report.filterSummary).toMatch(/selected customers \(1\)/);
  });

  test("balanceSide=credit returns only customers holding a credit", async () => {
    const a = await seedCompany("Alpha");
    const owing = await makeCustomer(a, "Owes Us");
    const credit = await makeCustomer(a, "In Credit");
    await postVoucher(a, owing, { amount: 100000 });
    await postVoucher(a, credit, { amount: 40000, partySide: "Cr", voucherType: "receipt" });

    const r = await call(q(a.company._id, "&balanceSide=credit"), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["In Credit"]);
    expect(r.body.report.totals.receivable).toBe(0);
  });
});

/* ── "Current filtered result" is exactly what was on screen ─────────────── */

describe("scope=filtered exports exactly the ledgers it was given", () => {
  /**
   * Four customers whose ONLY distinguishing marks are the fields the screen
   * searches and this service does not: email, phone and customer code. If the
   * export re-derived its own population from `search`, none of these would
   * come back — which is precisely the divergence being closed.
   */
  async function screenLikeCustomers() {
    const a = await seedCompany("Alpha");
    const byEmail = await makeCustomer(a, "Norwood Mills", {
      email: "accounts@zephyr-trading.example",
    });
    const byPhone = await makeCustomer(a, "Calder & Sons", { phone: "9812345678" });
    const byName = await makeCustomer(a, "Zephyr Garments Pvt Ltd");
    const other = await makeCustomer(a, "Unrelated Buyer");
    for (const l of [byEmail, byPhone, byName, other]) {
      await postVoucher(a, l, { amount: 50000 });
    }
    return { a, byEmail, byPhone, byName, other };
  }

  test("the exported population is EXACTLY the ids sent, in company order", async () => {
    const { a, byEmail, byPhone, byName } = await screenLikeCustomers();
    const ids = [byEmail._id, byPhone._id, byName._id];
    const r = await call(q(a.company._id, `&scope=filtered&ledgerIds=${ids.join(",")}`), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows.map((x) => x.ledgerId).sort()).toEqual(
      ids.map(String).sort(),
    );
    expect(r.body.report.rows.map((x) => x.name)).not.toContain("Unrelated Buyer");
    expect(r.body.report.filterSummary).toMatch(/current filtered result \(3\)/);
  });

  test("a screen search on EMAIL or PHONE cannot diverge from the export", async () => {
    // The screen matched these two on email and phone. The service's own
    // `search` matches name/aliases/GSTIN only, so a server-side re-derivation
    // would return nothing — the export must follow the ids instead.
    const { a, byEmail, byPhone } = await screenLikeCustomers();
    const ids = [byEmail._id, byPhone._id];

    const r = await call(
      q(
        a.company._id,
        // `search` is sent alongside on purpose: a stale client, or a user who
        // typed into the box after the rows were captured, must not be able to
        // shrink the population below what they were shown.
        `&scope=filtered&search=zephyr-trading&ledgerIds=${ids.join(",")}`,
      ),
      { user: orgFor(a.company) },
    );
    expect(r.body.report.rows.map((x) => x.ledgerId).sort()).toEqual(
      ids.map(String).sort(),
    );
    expect(r.body.report.rows.map((x) => x.name).sort()).toEqual([
      "Calder & Sons",
      "Norwood Mills",
    ]);
    expect(r.body.report.filterSummary).not.toMatch(/zephyr-trading/);
  });

  test("a screen filter with NO matches exports an EMPTY report, never every customer", async () => {
    const { a } = await screenLikeCustomers();
    const r = await call(q(a.company._id, "&scope=filtered&ledgerIds="), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.consideredLedgerCount).toBe(0);
    expect(r.body.report.totals.receivable).toBe(0);
    expect(r.body.report.totals.ledgerCount).toBe(0);
  });

  test("an empty filtered XLSX is still a valid, correctly-headed workbook", async () => {
    const { a } = await screenLikeCustomers();
    const res = await call(q(a.company._id, "&scope=filtered&ledgerIds=&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet("Outstanding");
    // Header + column names present; the totals row sits immediately under the
    // header because there are no data rows between them.
    expect(String(ws.getCell("A2").value)).toContain("Customer Outstanding Summary");
    expect(ws.getCell(7, 1).value).toBe("Code");
    expect(ws.getCell(8, 1).value).toBe("TOTAL");
    expect(ws.getCell(8, 6).value).toBe(0);
    expect(ws.getCell(8, 7).value).toBe(0);
  });

  test("scope=filtered with the ledgerIds parameter MISSING is refused", async () => {
    const { a } = await screenLikeCustomers();
    const r = await call(q(a.company._id, "&scope=filtered"), { user: orgFor(a.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_REPORT_REQUEST");
    expect(r.body.message).toMatch(/must send the ledger ids/);
  });

  test("a SPOOFED filtered id from another company is excluded", async () => {
    const { a, byName } = await screenLikeCustomers();
    const b = await seedCompany("Beta");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(b, bCust, { amount: 777777 });

    const r = await call(
      q(a.company._id, `&scope=filtered&ledgerIds=${byName._id},${bCust._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.status).toBe(200);
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Zephyr Garments Pvt Ltd"]);
    expect(JSON.stringify(r.body)).not.toContain("777777");
    expect(r.body.report.filterSummary).toMatch(/current filtered result \(1\)/);
  });

  test("a filtered set consisting ONLY of another company's ids exports nothing", async () => {
    const { a } = await screenLikeCustomers();
    const b = await seedCompany("Beta");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(b, bCust, { amount: 777777 });

    const r = await call(q(a.company._id, `&scope=filtered&ledgerIds=${bCust._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.totals.receivable).toBe(0);
  });

  test("a filtered id that is not a Sundry Debtor is excluded", async () => {
    const { a, byName } = await screenLikeCustomers();
    const supplier = await Acc_Ledger.create({
      companyId: a.company._id,
      name: "Alpha Supplier",
      groupId: a.creditors._id,
      groupName: a.creditors.name,
      nature: "liability",
    });
    const r = await call(
      q(a.company._id, `&scope=filtered&ledgerIds=${byName._id},${supplier._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Zephyr Garments Pvt Ltd"]);
  });
});

/* ── A large filtered set travels in a body, not a query string ──────────── */

describe("POST carries the same read when the id list is too long for a URL", () => {
  test("POST /outstanding returns the same report as the equivalent GET", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeCustomer(a, "Buyer One");
    const two = await makeCustomer(a, "Buyer Two");
    await postVoucher(a, one, { amount: 10000, date: "2026-05-01" });
    await postVoucher(a, two, { amount: 20000, date: "2026-05-01" });

    const ids = [String(one._id), String(two._id)];
    const viaGet = await call(
      q(a.company._id, `&scope=filtered&asOf=2026-06-30&ledgerIds=${ids.join(",")}`),
      { user: orgFor(a.company) },
    );
    const viaPost = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: {
        companyId: String(a.company._id),
        scope: "filtered",
        asOf: "2026-06-30",
        ledgerIds: ids,
      },
    });

    expect(viaPost.status).toBe(200);
    expect(viaPost.body.report.rows).toEqual(viaGet.body.report.rows);
    expect(viaPost.body.report.totals).toEqual(viaGet.body.report.totals);
    // Everything except the wall-clock stamp must be identical, so the
    // transport cannot change the report — including the company it is for.
    const shape = (b) => {
      const { generatedAt, ...rest } = b.report;
      return rest;
    };
    expect(shape(viaPost.body)).toEqual(shape(viaGet.body));
    expect(viaPost.body.report.company.companyId).toBe(String(a.company._id));
  });

  test("GET and POST produce equivalent XLSX for the same request", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeCustomer(a, "Buyer One");
    await postVoucher(a, one, { amount: 10000, date: "2026-05-01" });

    const params = `companyId=${a.company._id}&format=xlsx&asOf=2026-06-30&scope=selected&ledgerIds=${one._id}`;
    const getRes = await call(`/reports/outstanding?${params}`, {
      user: orgFor(a.company),
      raw: true,
    });
    const postRes = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      raw: true,
      body: {
        companyId: String(a.company._id),
        format: "xlsx",
        asOf: "2026-06-30",
        scope: "selected",
        ledgerIds: [String(one._id)],
      },
    });

    expect(getRes.headers.get("content-type")).toBe(postRes.headers.get("content-type"));
    expect(getRes.headers.get("content-disposition")).toBe(
      postRes.headers.get("content-disposition"),
    );

    const ExcelJS = require("exceljs");
    const read = async (res) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
      const ws = wb.getWorksheet("Outstanding");
      return [7, 8, 9].map((row) =>
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((col) => ws.getCell(row, col).value),
      );
    };
    expect(await read(postRes)).toEqual(await read(getRes));
  });

  test("POST honours an EMPTY filtered array without widening", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Buyer One").then((l) => postVoucher(a, l, { amount: 10000 }));
    const r = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(a.company._id), scope: "filtered", ledgerIds: [] },
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
  });

  test("POST is company-scoped by the same guards as GET", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const r = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });
    expect(r.status).toBe(403);
  });

  /* ── The company that is AUTHORISED is the company that is REPORTED ON ───
   *
   * Lane A's `requireCompanyAccess` resolves the company it checks as
   * `params || query || body` — query BEFORE body. When this router merged the
   * two sources with "body wins", a POST could be authorised for a company the
   * caller owned and then run against one they did not. These are the tests
   * that pin the fix: any request naming more than one company is refused
   * outright, so no preference order can separate the two.                   */

  test("authorised A in the query and unauthorised B in the body is REFUSED, and leaks no B data", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await postVoucher(a, aCust, { amount: 11000 });
    await postVoucher(b, bCust, { amount: 999999 });

    const r = await call(`/reports/outstanding?companyId=${a.company._id}`, {
      user: orgFor(a.company), // owns A only
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });

    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
    const serialised = JSON.stringify(r.body);
    expect(serialised).not.toContain("Beta Buyer");
    expect(serialised).not.toContain("999999");
    expect(serialised).not.toContain("Alpha Buyer");
    expect(r.body.report).toBeUndefined();
  });

  test("unauthorised B in the query and authorised A in the body is REFUSED", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));

    const r = await call(`/reports/outstanding?companyId=${b.company._id}`, {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(a.company._id), scope: "all" },
    });

    // Refused as a conflict before membership is even consulted — the request
    // is unanswerable, not merely unauthorised.
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
    expect(r.body.report).toBeUndefined();
  });

  test("the conflict is refused even when BOTH companies are owned", async () => {
    // Nothing about ownership makes "authorise one, report the other"
    // meaningful — the request still names two companies and one answer.
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const bothOwned = {
      user: { id: new mongoose.Types.ObjectId().toString(), role: "owner" },
      organization: {
        tallyCompanyIds: [String(a.company._id), String(b.company._id)],
      },
    };
    const r = await call(`/reports/outstanding?companyId=${a.company._id}`, {
      user: bothOwned,
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("the SAME companyId in both places is not a conflict", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));
    const r = await call(`/reports/outstanding?companyId=${a.company._id}`, {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(a.company._id), scope: "all" },
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Alpha Buyer"]);
  });

  test("an EMPTY companyId alongside a real one is not a conflict — empty is 'not given'", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));
    const r = await call("/reports/outstanding?companyId=", {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(a.company._id), scope: "all" },
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Alpha Buyer"]);
  });

  test("body-only POST succeeds and reports on the body's company", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));
    await makeCustomer(b, "Beta Buyer").then((l) => postVoucher(b, l, { amount: 999999 }));

    const r = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(a.company._id), scope: "all" },
    });
    expect(r.status).toBe(200);
    expect(r.body.report.company.companyId).toBe(String(a.company._id));
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Alpha Buyer"]);
  });

  test("query-only GET succeeds and reports on the query's company", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 11000 }));
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    expect(r.body.report.company.companyId).toBe(String(a.company._id));
  });

  test("a body-only POST for a company the organisation does not own is still a 403", async () => {
    // The conflict check must not become a way to skip the membership check.
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const r = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });
    expect(r.status).toBe(403);
  });

  test("the ledger statement route rejects a conflicting companyId too", async () => {
    // `fetch` refuses to put a body on a GET, but plenty of HTTP clients will,
    // and `express.json()` parses it when they do — so the guard has to hold
    // on the GET-only route as well, not just where the browser can reach it.
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 11000 });

    const r = await rawRequest({
      method: "GET",
      path: `/reports/ledger/${cust._id}?companyId=${a.company._id}`,
      user: orgFor(a.company),
      body: { companyId: String(b.company._id) },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
    expect(JSON.stringify(r.body)).not.toContain("Alpha Buyer");
  });

  test("the ledger statement route still works on a plain GET", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 11000 });
    const r = await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}`, {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.statement.ledger.name).toBe("Alpha Buyer");
  });

  test("POST with no companyId anywhere fails closed", async () => {
    const a = await seedCompany("Alpha");
    const r = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: { scope: "all" },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("POST streams a real XLSX for a large filtered set", async () => {
    const a = await seedCompany("Alpha");
    const docs = Array.from({ length: 600 }, (_, i) => ({
      companyId: a.company._id,
      name: `Buyer ${String(i).padStart(3, "0")}`,
      groupId: a.debtors._id,
      groupName: a.debtors.name,
      nature: "asset",
      openingBalance: 1000 + i,
      openingBalanceType: "Dr",
    }));
    const made = await Acc_Ledger.insertMany(docs);
    const ids = made.map((l) => String(l._id));

    const res = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      raw: true,
      body: {
        companyId: String(a.company._id),
        scope: "filtered",
        format: "xlsx",
        ledgerIds: ids,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet("Outstanding");
    expect(ws.getCell(7 + 600 + 1, 1).value).toBe("TOTAL");
  });
});

/* ── The minimum balance behaves the same in every scope ─────────────────── */

describe("minimum balance is applied consistently across scopes", () => {
  async function bigAndSmall() {
    const a = await seedCompany("Alpha");
    const big = await makeCustomer(a, "Big Buyer");
    const small = await makeCustomer(a, "Small Buyer");
    await postVoucher(a, big, { amount: 100000, date: "2026-05-01" });
    await postVoucher(a, small, { amount: 900, date: "2026-05-01" });
    return { a, big, small };
  }

  test("all: a balance under the minimum is dropped", async () => {
    const { a } = await bigAndSmall();
    const r = await call(q(a.company._id, "&minOutstanding=1000"), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Big Buyer"]);
  });

  test("filtered: the SAME minimum drops the SAME row", async () => {
    const { a, big, small } = await bigAndSmall();
    const r = await call(
      q(a.company._id, `&scope=filtered&minOutstanding=1000&ledgerIds=${big._id},${small._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Big Buyer"]);
    expect(r.body.report.consideredLedgerCount).toBe(2);
    expect(r.body.report.filterSummary).toMatch(/Minimum balance: ₹1,000/);
  });

  test("selected: the minimum is applied, not silently ignored", async () => {
    // This is the correction: the input was shown for a selected export and
    // then dropped, so a user who typed 1,000 and ticked both rows got both.
    const { a, big, small } = await bigAndSmall();
    const r = await call(
      q(a.company._id, `&scope=selected&minOutstanding=1000&ledgerIds=${big._id},${small._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Big Buyer"]);
    expect(r.body.report.filterSummary).toMatch(/Minimum balance: ₹1,000/);
  });

  test("a zero minimum keeps every non-nil balance in every scope", async () => {
    const { a, big, small } = await bigAndSmall();
    const both = `${big._id},${small._id}`;
    for (const extra of [
      "&minOutstanding=0",
      `&scope=filtered&minOutstanding=0&ledgerIds=${both}`,
      `&scope=selected&minOutstanding=0&ledgerIds=${both}`,
    ]) {
      const r = await call(q(a.company._id, extra), { user: orgFor(a.company) });
      expect(r.body.report.rows.map((x) => x.name).sort()).toEqual([
        "Big Buyer",
        "Small Buyer",
      ]);
    }
  });
});

/* ── Every outstanding report is dated ───────────────────────────────────── */

describe("the as-of date is deterministic and always present", () => {
  test("a MISSING asOf cannot include a future-dated voucher", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 10000, date: "2026-05-01" });
    // Dated years ahead so this test cannot expire.
    await postVoucher(a, cust, { amount: 5000000, date: "2099-01-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    expect(r.body.report.rows[0].balance).toBe(10000);
    expect(r.body.report.rows[0].transactionCount).toBe(1);
    expect(r.body.report.totals.receivable).toBe(10000);
    expect(JSON.stringify(r.body)).not.toContain("5000000");
  });

  test("a missing asOf resolves to today, and the report says so", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 10000 }));
    const r = await call(q(a.company._id), { user: orgFor(a.company) });

    expect(r.body.report.asOf).toBeTruthy();
    const asOf = new Date(r.body.report.asOf);
    const generated = new Date(r.body.report.generatedAt);
    expect(asOf.getTime()).toBeGreaterThanOrEqual(generated.getTime() - 1000);
    // End of the current business day is always within 24h of now.
    expect(asOf.getTime() - generated.getTime()).toBeLessThan(24 * 3600 * 1000);
  });

  test("a missing asOf still produces a DATED filename, in both formats", async () => {
    const a = await seedCompany("Alpha Textiles Pvt. Ltd.");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 10000 }));

    for (const [format, ext] of [["xlsx", "xlsx"], ["pdf", "pdf"]]) {
      const res = await call(q(a.company._id, `&format=${format}`), {
        user: orgFor(a.company),
        raw: true,
      });
      expect(res.status).toBe(200);
      const cd = res.headers.get("content-disposition");
      expect(cd).toMatch(
        new RegExp(`alpha-textiles-pvt-ltd-customer-outstanding-as-on-\\d{4}-\\d{2}-\\d{2}\\.${ext}`),
      );
    }
  });

  test("a missing asOf still prints an as-on line in the workbook header", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer").then((l) => postVoucher(a, l, { amount: 10000 }));
    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    // en-IN abbreviates September as "Sept", so the month is \w+ not \w{3}.
    expect(String(wb.getWorksheet("Outstanding").getCell("A3").value)).toMatch(
      /^As on: \d{2} \w+ \d{4}$/,
    );
  });

  test("an explicit asOf still wins over the default", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer");
    await postVoucher(a, cust, { amount: 10000, date: "2026-05-01" });
    await postVoucher(a, cust, { amount: 25000, date: "2026-07-15" });

    const r = await call(q(a.company._id, "&asOf=2026-06-30"), { user: orgFor(a.company) });
    expect(r.body.report.rows[0].balance).toBe(10000);
  });
});

/* ── CRM data must not leak into an accounting figure ────────────────────── */

describe("CRM quotations and Customer Requests do not affect Accounting outstanding", () => {
  test("a huge unpaid quotation on a linked CRM customer changes nothing", async () => {
    const a = await seedCompany("Alpha");
    const crm = await Customer.create({
      name: "Alpha Buyer",
      email: `buyer-${Date.now()}@example.com`,
      phone: "9999999999",
      password: "irrelevant-but-required",
    });
    const cust = await makeCustomer(a, "Alpha Buyer");
    await Acc_Ledger.updateOne({ _id: cust._id }, { $set: { linkedCustomerId: crm._id } });
    await postVoucher(a, cust, { amount: 10000 });

    await CustomerRequest.create({
      customerId: crm._id,
      quotations: [{ grandTotal: 7500000, quotationNumber: "Q-1" }],
      totalPaidAmount: 0,
    });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.balance).toBe(10000);
    expect(r.body.report.totals.receivable).toBe(10000);
    expect(JSON.stringify(r.body)).not.toContain("7500000");
  });

  test("a CRM-only customer with no ledger does not appear in the accounting report at all", async () => {
    const a = await seedCompany("Alpha");
    const crm = await Customer.create({
      name: "Sales Only Buyer",
      email: `salesonly-${Date.now()}@example.com`,
      phone: "8888888888",
      password: "irrelevant-but-required",
    });
    await CustomerRequest.create({
      customerId: crm._id,
      quotations: [{ grandTotal: 250000, quotationNumber: "Q-2" }],
      totalPaidAmount: 0,
    });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.totals.receivable).toBe(0);
  });
});

/* ── Individual statement ────────────────────────────────────────────────── */

describe("individual customer ledger / statement", () => {
  async function statementFixture() {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Statement Buyer", {
      openingBalance: 5000,
      openingBalanceType: "Dr",
    });
    await postVoucher(a, cust, { amount: 20000, date: "2026-04-10", voucherNumber: "INV-1" });
    await postVoucher(a, cust, {
      amount: 8000,
      date: "2026-04-20",
      partySide: "Cr",
      voucherType: "receipt",
      voucherNumber: "RCT-1",
    });
    await postVoucher(a, cust, { amount: 12000, date: "2026-06-05", voucherNumber: "INV-2" });
    await postVoucher(a, cust, {
      amount: 3000,
      date: "2026-06-25",
      partySide: "Cr",
      voucherType: "receipt",
      voucherNumber: "RCT-2",
    });
    // Excluded — after the window, and not posted.
    await postVoucher(a, cust, { amount: 99000, date: "2026-09-01", voucherNumber: "INV-LATER" });
    await postVoucher(a, cust, { amount: 4000, date: "2026-06-10", status: "draft", voucherNumber: "DRAFT-1" });
    return { a, cust };
  }

  test("with no dates, opening is the ledger master opening and closing reconciles", async () => {
    const { a, cust } = await statementFixture();
    const r = await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}`, {
      user: orgFor(a.company),
    });
    const s = r.body.statement;
    expect(s.opening.amount).toBe(5000);
    expect(s.opening.type).toBe("Dr");
    expect(s.totals.debit).toBe(131000); // 20000 + 12000 + 99000
    expect(s.totals.credit).toBe(11000); // 8000 + 3000
    expect(s.closing.signed).toBe(5000 + 131000 - 11000);
    expect(s.closing.type).toBe("Dr");
    expect(s.rows.map((x) => x.voucherNumber)).not.toContain("DRAFT-1");
  });

  test("the running balance is opening plus every movement so far, in date order", async () => {
    const { a, cust } = await statementFixture();
    const r = await call(
      `/reports/ledger/${cust._id}?companyId=${a.company._id}&asOf=2026-06-30`,
      { user: orgFor(a.company) },
    );
    const s = r.body.statement;
    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["INV-1", "RCT-1", "INV-2", "RCT-2"]);
    expect(s.rows.map((x) => x.runningSigned)).toEqual([25000, 17000, 29000, 26000]);

    // Every running balance equals opening + the movement above it.
    let running = s.opening.signed;
    for (const row of s.rows) {
      running += row.debit - row.credit;
      expect(row.runningSigned).toBeCloseTo(running, 2);
    }
    expect(s.closing.signed).toBeCloseTo(running, 2);
    expect(s.closing.signed).toBeCloseTo(
      s.opening.signed + s.totals.debit - s.totals.credit,
      2,
    );
  });

  test("a DATE-RANGE opening includes every posted movement before `from`", async () => {
    const { a, cust } = await statementFixture();
    const r = await call(
      `/reports/ledger/${cust._id}?companyId=${a.company._id}&from=2026-06-01&to=2026-06-30`,
      { user: orgFor(a.company) },
    );
    const s = r.body.statement;

    // 5,000 master opening + 20,000 INV-1 − 8,000 RCT-1 = 17,000 — NOT 5,000.
    expect(s.opening.signed).toBe(17000);
    expect(s.opening.masterOpening).toBe(5000);
    expect(s.opening.priorMovement).toBe(12000);
    expect(s.opening.priorVoucherCount).toBe(2);

    expect(s.rows.map((x) => x.voucherNumber)).toEqual(["INV-2", "RCT-2"]);
    expect(s.closing.signed).toBe(26000);
    expect(s.closing.signed).toBe(s.opening.signed + s.totals.debit - s.totals.credit);
  });

  test("a period statement's closing equals the as-of report's balance for the same date", async () => {
    const { a, cust } = await statementFixture();
    const stmt = (
      await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}&from=2026-06-01&to=2026-06-30`, {
        user: orgFor(a.company),
      })
    ).body.statement;
    const summary = (
      await call(q(a.company._id, "&asOf=2026-06-30"), { user: orgFor(a.company) })
    ).body.report;
    const row = summary.rows.find((x) => x.ledgerId === String(cust._id));
    expect(row.signedBalance).toBe(stmt.closing.signed);
  });

  test("a closing balance on the credit side is reported as Cr, not a negative Dr", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Overpaid Buyer");
    await postVoucher(a, cust, { amount: 5000, date: "2026-05-01" });
    await postVoucher(a, cust, {
      amount: 9000,
      date: "2026-05-10",
      partySide: "Cr",
      voucherType: "receipt",
    });
    const s = (
      await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}`, {
        user: orgFor(a.company),
      })
    ).body.statement;
    expect(s.closing.type).toBe("Cr");
    expect(s.closing.amount).toBe(4000);
    expect(s.rows[1].runningType).toBe("Cr");
    expect(s.rows[1].runningBalance).toBe(4000);
  });
});

/* ── Read-only ───────────────────────────────────────────────────────────── */

describe("generating a report changes nothing", () => {
  test("ledger, voucher and customer documents are byte-identical afterwards", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Alpha Buyer", {
      openingBalance: 5000,
      openingBalanceType: "Dr",
    });
    await postVoucher(a, cust, { amount: 10000 });

    const before = {
      ledgers: await Acc_Ledger.find({}).lean(),
      vouchers: await Acc_Voucher.find({}).lean(),
      companies: await Acc_Company.find({}).lean(),
    };

    await call(q(a.company._id), { user: orgFor(a.company) });
    await call(q(a.company._id, "&format=xlsx"), { user: orgFor(a.company), raw: true });
    await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}&format=pdf`, {
      user: orgFor(a.company),
      raw: true,
    });

    const after = {
      ledgers: await Acc_Ledger.find({}).lean(),
      vouchers: await Acc_Voucher.find({}).lean(),
      companies: await Acc_Company.find({}).lean(),
    };
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

/* ── The files themselves ────────────────────────────────────────────────── */

describe("Excel and PDF responses", () => {
  const XLSX_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  async function twoCustomers() {
    const a = await seedCompany("Alpha Textiles Pvt. Ltd.");
    const big = await makeCustomer(a, "Big Buyer Pvt Ltd", { gstin: "27AAAAA0000A1Z5" });
    const cred = await makeCustomer(a, "In Credit Buyer");
    await postVoucher(a, big, { amount: 123456.78, date: "2026-05-01" });
    await postVoucher(a, cred, {
      amount: 4321.5,
      date: "2026-05-02",
      partySide: "Cr",
      voucherType: "receipt",
    });
    return { a, big, cred };
  }

  test("the outstanding XLSX has the right content type and a safe, descriptive filename", async () => {
    const { a } = await twoCustomers();
    const res = await call(q(a.company._id, "&format=xlsx&asOf=2026-06-30"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);
    const cd = res.headers.get("content-disposition");
    expect(cd).toContain("attachment;");
    expect(cd).toContain("alpha-textiles-pvt-ltd-customer-outstanding-as-on-2026-06-30.xlsx");
    // Nothing that could break or inject into the header survived the slug.
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd.match(/filename="([^"]+)"/)[1]).toMatch(/^[a-z0-9.-]+$/);
  });

  test("the outstanding PDF has the right content type and starts with a PDF header", async () => {
    const { a } = await twoCustomers();
    const res = await call(q(a.company._id, "&format=pdf&asOf=2026-06-30"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-textiles-pvt-ltd-customer-outstanding-as-on-2026-06-30.pdf",
    );
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  });

  test("Excel amount cells hold NUMBERS, and the totals are correct", async () => {
    const { a } = await twoCustomers();
    const res = await call(q(a.company._id, "&format=xlsx&asOf=2026-06-30"), {
      user: orgFor(a.company),
      raw: true,
    });
    const buf = Buffer.from(await res.arrayBuffer());

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet("Outstanding");

    // Header block says company, report, as-of date and filters.
    expect(String(ws.getCell("A1").value)).toBe("Alpha Textiles Pvt. Ltd.");
    expect(String(ws.getCell("A2").value)).toContain("Customer Outstanding Summary");
    expect(String(ws.getCell("A3").value)).toContain("As on:");
    expect(String(ws.getCell("A4").value)).toContain("Filters —");

    // Frozen header + autofilter.
    expect(ws.views[0].state).toBe("frozen");
    expect(ws.views[0].ySplit).toBe(7);
    expect(ws.autoFilter).toBeTruthy();

    const headers = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => ws.getCell(7, c).value);
    expect(headers).toEqual([
      "Code",
      "Customer",
      "GSTIN",
      "Outstanding",
      "Dr/Cr",
      "Receivable (Dr)",
      "Credit (Cr)",
      "Txns",
      "Last Txn",
    ]);

    // Rows are alphabetical: Big Buyer, then In Credit Buyer.
    const bigOutstanding = ws.getCell(8, 4);
    expect(typeof bigOutstanding.value).toBe("number");
    expect(bigOutstanding.value).toBeCloseTo(123456.78, 2);
    expect(bigOutstanding.numFmt).toBe('"₹"#,##0.00');
    expect(ws.getCell(8, 5).value).toBe("Dr");
    expect(typeof ws.getCell(8, 8).value).toBe("number");

    const credOutstanding = ws.getCell(9, 4);
    expect(typeof credOutstanding.value).toBe("number");
    expect(credOutstanding.value).toBeCloseTo(4321.5, 2);
    expect(ws.getCell(9, 5).value).toBe("Cr");

    // Totals row: receivables and credits reported separately.
    const totalRow = 10;
    expect(ws.getCell(totalRow, 1).value).toBe("TOTAL");
    expect(typeof ws.getCell(totalRow, 6).value).toBe("number");
    expect(ws.getCell(totalRow, 6).value).toBeCloseTo(123456.78, 2);
    expect(ws.getCell(totalRow, 7).value).toBeCloseTo(4321.5, 2);
  });

  test("the individual ledger XLSX carries date, type, number, narration, Dr, Cr, balance and side", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Statement Buyer", {
      openingBalance: 5000,
      openingBalanceType: "Dr",
    });
    await postVoucher(a, cust, {
      amount: 20000,
      date: "2026-04-10",
      voucherNumber: "INV-1",
      voucherTypeName: "Tax Invoice",
      narration: "April supply",
    });
    await postVoucher(a, cust, {
      amount: 8000,
      date: "2026-04-20",
      partySide: "Cr",
      voucherType: "receipt",
      voucherNumber: "RCT-1",
      narration: "NEFT",
    });

    const res = await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}&format=xlsx`, {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);
    expect(res.headers.get("content-disposition")).toContain("customer-ledger-statement-buyer");

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet("Ledger");

    expect([1, 2, 3, 4, 5, 6, 7, 8].map((c) => ws.getCell(7, c).value)).toEqual([
      "Date",
      "Voucher Type",
      "Voucher No.",
      "Narration",
      "Debit",
      "Credit",
      "Balance",
      "Dr/Cr",
    ]);

    // Row 8 is the OPENING band.
    expect(ws.getCell(8, 4).value).toBe("Opening Balance");
    expect(ws.getCell(8, 7).value).toBe(5000);
    expect(ws.getCell(8, 8).value).toBe("Dr");

    expect(ws.getCell(9, 2).value).toBe("Tax Invoice");
    expect(ws.getCell(9, 3).value).toBe("INV-1");
    expect(ws.getCell(9, 4).value).toBe("April supply");
    expect(typeof ws.getCell(9, 5).value).toBe("number");
    expect(ws.getCell(9, 5).value).toBe(20000);
    expect(ws.getCell(9, 7).value).toBe(25000);

    expect(ws.getCell(10, 6).value).toBe(8000);
    expect(ws.getCell(10, 7).value).toBe(17000);

    // CLOSING band, with the movement totals beside it.
    expect(ws.getCell(11, 4).value).toBe("Closing Balance");
    expect(ws.getCell(11, 5).value).toBe(20000);
    expect(ws.getCell(11, 6).value).toBe(8000);
    expect(ws.getCell(11, 7).value).toBe(17000);
    expect(ws.getCell(11, 8).value).toBe("Dr");
  });

  test("the individual ledger PDF renders and names the customer in the file", async () => {
    const a = await seedCompany("Alpha");
    const cust = await makeCustomer(a, "Statement Buyer");
    await postVoucher(a, cust, { amount: 20000, date: "2026-04-10" });
    const res = await call(
      `/reports/ledger/${cust._id}?companyId=${a.company._id}&format=pdf&from=2026-04-01&to=2026-04-30`,
      { user: orgFor(a.company), raw: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      "customer-ledger-statement-buyer-2026-04-01-to-2026-04-30.pdf",
    );
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  test("an unknown format is refused rather than guessed", async () => {
    const a = await seedCompany("Alpha");
    const r = await call(q(a.company._id, "&format=csv"), { user: orgFor(a.company) });
    expect(r.status).toBe(400);
  });

  test("a 200-customer report paginates the PDF without dropping anyone", async () => {
    const a = await seedCompany("Alpha");
    const docs = [];
    for (let i = 0; i < 200; i += 1) {
      docs.push({
        companyId: a.company._id,
        name: `Buyer ${String(i).padStart(3, "0")} — a deliberately long trading name that would clip`,
        groupId: a.debtors._id,
        groupName: a.debtors.name,
        nature: "asset",
        openingBalance: 1000 + i,
        openingBalanceType: "Dr",
      });
    }
    await Acc_Ledger.insertMany(docs);

    const json = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(json.body.report.rows.length).toBe(200);

    const res = await call(q(a.company._id, "&format=pdf"), {
      user: orgFor(a.company),
      raw: true,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    // 200 rows at 15pt cannot fit one A4 page — the writer must have paged.
    expect(buf.toString("latin1")).toMatch(/\/Count\s+[2-9]/);
  });
});

/* ── The existing Customer Master export must keep working ───────────────── */

describe("the existing Customer Master export is untouched", () => {
  test("GET /export/xlsx still returns a workbook", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer");
    const res = await call(`/export/xlsx?companyId=${a.company._id}`, {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toContain("customer-master-");
  });

  test("GET /export/pdf still returns a PDF", async () => {
    const a = await seedCompany("Alpha");
    await makeCustomer(a, "Alpha Buyer");
    const res = await call(`/export/pdf?companyId=${a.company._id}`, {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).slice(0, 5).toString()).toBe("%PDF-");
  });
});
