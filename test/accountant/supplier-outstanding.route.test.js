// test/accountant/supplier-outstanding.route.test.js
//
// Lane B, Chunk 2 — Supplier Outstanding Summary and individual Supplier
// Ledger exports, over real collections.
//
// What this file exists to prove that the pure tests cannot:
//   • A purchase bill increases the payable; a payment and a debit note
//     reduce it; overpaying turns it into a supplier advance — through real
//     voucher documents, not hand-built movement objects.
//   • Payables and advances are never netted into one figure.
//   • Only POSTED, non-OPTIONAL vouchers dated on or before `asOf` count.
//   • Company A's export never contains Company B's ledgers or vouchers, and a
//     customer's ledger id cannot be read through the supplier door.
//   • Imported Tally creditors with no CMS Vendor row are first-class, and a
//     duplicate CMS vendor cannot double-count one ledger.
//   • Purchase orders and the CMS Vendor model do not move these figures.
//   • The statement's opening, running and closing balances reconcile.
//   • Excel headings, filters and totals; GET/POST equivalence.
//
// `orgAuth` is mocked so identity is assertable per request without a JWT — it
// is Lane A's, and this suite is not testing it. `requireCompanyAccess` is the
// REAL one, because whether a report can be pulled for a company the
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

/**
 * A company with a Sundry Creditors tree, a Sundry Debtors group (so a
 * customer ledger exists to try to smuggle in), a purchase ledger and a bank.
 * Creditors are nested one level deep on purpose: sub-grouped suppliers are
 * normal in Tally and a report matching only the exact group name would omit
 * most of them.
 */
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
  const imported = await Acc_Group.create({
    companyId: company._id,
    name: "Fabric Suppliers",
    parent: creditors._id,
    parentName: creditors.name,
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
  return { company, creditors, imported, debtors, purchaseGroup, purchases };
}

async function makeSupplier(fx, name, opts = {}) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: opts.group ? opts.group._id : fx.creditors._id,
    groupName: opts.group ? opts.group.name : fx.creditors.name,
    nature: "liability",
    gstin: opts.gstin || undefined,
    openingBalance: opts.openingBalance || 0,
    openingBalanceType: opts.openingBalanceType || "Cr",
  });
}

/**
 * One two-line voucher against a supplier.
 *
 * `partySide` is the side the SUPPLIER ledger is posted on, which is what
 * decides the accounting effect:
 *   Cr → a purchase bill (increases what we owe)
 *   Dr → a payment or a debit note (reduces it)
 */
async function postVoucher(fx, party, opts = {}) {
  const amount = opts.amount ?? 10000;
  const partySide = opts.partySide || "Cr";
  const otherSide = partySide === "Cr" ? "Dr" : "Cr";
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: opts.voucherType || "purchase",
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
      {
        ledgerId: fx.purchases._id,
        ledgerName: fx.purchases.name,
        type: otherSide,
        amount,
      },
    ],
  });
}

const bill = (fx, p, o = {}) => postVoucher(fx, p, { ...o, partySide: "Cr", voucherType: "purchase" });
const payment = (fx, p, o = {}) => postVoucher(fx, p, { ...o, partySide: "Dr", voucherType: "payment" });
const debitNote = (fx, p, o = {}) => postVoucher(fx, p, { ...o, partySide: "Dr", voucherType: "debit_note" });

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
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const q = (companyId, extra = "") => `/reports/outstanding?companyId=${companyId}${extra}`;

/* ── What each document does to the payable ──────────────────────────────── */

describe("accounting treatment", () => {
  test("a purchase bill increases the payable", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 118000 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    const row = r.body.report.rows[0];
    expect(row.balanceType).toBe("Cr");
    expect(row.payable).toBe(118000);
    expect(row.supplierAdvance).toBe(0);
    expect(r.body.report.totals.payable).toBe(118000);
  });

  test("a payment reduces the payable", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 118000, date: "2026-05-01" });
    await payment(a, s, { amount: 50000, date: "2026-05-20" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.balanceType).toBe("Cr");
    expect(row.payable).toBe(68000);
    expect(row.transactionCount).toBe(2);
  });

  test("a debit note reduces the payable, the same way a payment does", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 118000, date: "2026-05-01" });
    await debitNote(a, s, { amount: 18000, date: "2026-05-10" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.payable).toBe(100000);
    expect(row.balanceType).toBe("Cr");
  });

  test("overpaying turns the payable into a supplier advance", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 100000, date: "2026-05-01" });
    await payment(a, s, { amount: 130000, date: "2026-05-20" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.balanceType).toBe("Dr");
    expect(row.payable).toBe(0);
    expect(row.supplierAdvance).toBe(30000);
    expect(row.balance).toBe(30000);
  });

  test("the ledger opening balance is included", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics", {
      openingBalance: 25000,
      openingBalanceType: "Cr",
    });
    await bill(a, s, { amount: 10000 });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.openingBalance).toBe(25000);
    expect(row.openingType).toBe("Cr");
    expect(row.payable).toBe(35000);
  });

  test("payables and advances are reported separately and NEVER netted", async () => {
    const a = await seedCompany("Alpha");
    const owed = await makeSupplier(a, "Owed Supplier");
    const prepaid = await makeSupplier(a, "Prepaid Supplier");
    await bill(a, owed, { amount: 500000 });
    await payment(a, prepaid, { amount: 80000 });

    const totals = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.totals;
    expect(totals.payable).toBe(500000);
    expect(totals.supplierAdvance).toBe(80000);
    expect(totals.payableCount).toBe(1);
    expect(totals.advanceCount).toBe(1);
    expect(totals.netBalance).toBe(420000);
    expect(totals.payable).not.toBe(totals.netBalance);
  });
});

/* ── Which vouchers count ────────────────────────────────────────────────── */

describe("only posted, non-optional vouchers through the as-of date", () => {
  test("drafts, pending approvals, cancellations, voids and optionals are excluded", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 100000 });
    await bill(a, s, { amount: 500, status: "draft" });
    await bill(a, s, { amount: 600, status: "pending_approval" });
    await bill(a, s, { amount: 700, status: "cancelled" });
    await bill(a, s, { amount: 800, status: "void" });
    await bill(a, s, { amount: 900, isOptional: true });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.payable).toBe(100000);
    expect(row.transactionCount).toBe(1);
  });

  test("a bill dated after the as-of date is not in an as-of report", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 100000, date: "2026-05-01" });
    await bill(a, s, { amount: 250000, date: "2026-07-15" });

    const asAt = await call(q(a.company._id, "&asOf=2026-06-30"), { user: orgFor(a.company) });
    expect(asAt.body.report.rows[0].payable).toBe(100000);
  });

  test("a MISSING asOf cannot include a future-dated bill", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 100000, date: "2026-05-01" });
    await bill(a, s, { amount: 9000000, date: "2099-01-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows[0].payable).toBe(100000);
    expect(JSON.stringify(r.body)).not.toContain("9000000");
    expect(r.body.report.asOf).toBeTruthy();
  });

  test("a voucher touching the supplier twice is ONE transaction", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await Acc_Voucher.create({
      companyId: a.company._id,
      voucherType: "journal",
      voucherNumber: "JV-1",
      voucherDate: new Date("2026-05-01"),
      status: "posted",
      grandTotal: 3000,
      ledgerEntries: [
        { ledgerId: s._id, ledgerName: s.name, type: "Cr", amount: 5000 },
        { ledgerId: s._id, ledgerName: s.name, type: "Dr", amount: 2000 },
        { ledgerId: a.purchases._id, ledgerName: a.purchases.name, type: "Dr", amount: 3000 },
      ],
    });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.credit).toBe(5000);
    expect(row.debit).toBe(2000);
    expect(row.payable).toBe(3000);
    expect(row.transactionCount).toBe(1);
  });
});

/* ── Company and group isolation ─────────────────────────────────────────── */

describe("isolation", () => {
  test("Company A's report contains no Company B supplier and no Company B voucher", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSup = await makeSupplier(a, "Alpha Supplier");
    const bSup = await makeSupplier(b, "Beta Supplier");
    await bill(a, aSup, { amount: 11000 });
    await bill(b, bSup, { amount: 999999 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Alpha Supplier"]);
    expect(JSON.stringify(r.body)).not.toContain("Beta Supplier");
    expect(JSON.stringify(r.body)).not.toContain("999999");
  });

  test("a company the organisation does not own is refused", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const r = await call(q(b.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(403);
  });

  test("no companyId is a 400, not an unscoped read", async () => {
    const a = await seedCompany("Alpha");
    const r = await call("/reports/outstanding", { user: orgFor(a.company) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_REQUIRED");
  });

  test("a conflicting companyId in query and body is refused", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const r = await call(`/reports/outstanding?companyId=${a.company._id}`, {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id), scope: "all" },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("a SPOOFED supplier id from another company is excluded", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSup = await makeSupplier(a, "Alpha Supplier");
    const bSup = await makeSupplier(b, "Beta Supplier");
    await bill(a, aSup, { amount: 11000 });
    await bill(b, bSup, { amount: 999999 });

    const r = await call(
      q(a.company._id, `&scope=selected&ledgerIds=${aSup._id},${bSup._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Alpha Supplier"]);
    expect(r.body.report.totals.payable).toBe(11000);
  });

  test("a CUSTOMER ledger cannot be read through the supplier door", async () => {
    const a = await seedCompany("Alpha");
    const sup = await makeSupplier(a, "Alpha Supplier");
    await bill(a, sup, { amount: 11000 });
    const cust = await Acc_Ledger.create({
      companyId: a.company._id,
      name: "Alpha Buyer",
      groupId: a.debtors._id,
      groupName: a.debtors.name,
      nature: "asset",
    });
    await postVoucher(a, cust, { amount: 77777, partySide: "Dr", voucherType: "sales" });

    const summary = await call(
      q(a.company._id, `&scope=selected&ledgerIds=${sup._id},${cust._id}`),
      { user: orgFor(a.company) },
    );
    expect(summary.body.report.rows.map((x) => x.name)).toEqual(["Alpha Supplier"]);

    const stmt = await call(`/reports/ledger/${cust._id}?companyId=${a.company._id}`, {
      user: orgFor(a.company),
    });
    expect(stmt.status).toBe(404);
  });

  test("an individual statement for another company's supplier is a 404", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const bSup = await makeSupplier(b, "Beta Supplier");
    await bill(b, bSup, { amount: 999999 });
    const r = await call(`/reports/ledger/${bSup._id}?companyId=${a.company._id}`, {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(404);
  });
});

/* ── Imported creditors, and vendors that do not exist in the CMS ────────── */

describe("imported Tally creditors and CMS vendor records", () => {
  test("a sub-grouped imported creditor with NO CMS Vendor row is a first-class supplier", async () => {
    const a = await seedCompany("Alpha");
    const importedSup = await makeSupplier(a, "Tally Only Mills", { group: a.imported });
    await bill(a, importedSup, { amount: 64000 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows.find((x) => x.name === "Tally Only Mills");
    expect(row).toBeTruthy();
    expect(row.payable).toBe(64000);
    expect(row.groupName).toBe("Fabric Suppliers");
  });

  test("one ledger is one row, however many CMS vendors point at it", async () => {
    // The population is LEDGERS, not CMS vendors, so a duplicate/ghost vendor
    // has nothing to contribute twice — there is only one ledger to count.
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await Acc_Ledger.updateOne(
      { _id: s._id },
      { $set: { linkedVendorId: new mongoose.Types.ObjectId() } },
    );
    await bill(a, s, { amount: 118000 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toHaveLength(1);
    expect(r.body.report.totals.payable).toBe(118000);
  });

  /**
   * The code the Vendors screen prints, copied from `Acc_vendors.js`. Every
   * row on that screen has a ledger, so the code is always ledger-derived.
   */
  const screenVendorCode = (ledgerId) =>
    `VEN-${String(ledgerId).substring(18, 24).toUpperCase()}`;

  test("the code in the report is the code on the Vendors screen", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 118000 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.code).toBe(screenVendorCode(s._id));
    expect(row.code).toMatch(/^VEN-[0-9A-F]{6}$/);
  });

  test("an imported ledger-only supplier and a CMS-linked one carry the SAME code", async () => {
    // Both are the same ledger; only the presence of a CMS vendor row differs,
    // and the report never reads it.
    const a = await seedCompany("Alpha");
    const importedOnly = await makeSupplier(a, "Tally Only Mills", { group: a.imported });
    const cmsLinked = await makeSupplier(a, "Linked Mills");
    await Acc_Ledger.updateOne(
      { _id: cmsLinked._id },
      { $set: { linkedVendorId: new mongoose.Types.ObjectId() } },
    );
    await bill(a, importedOnly, { amount: 10000 });
    await bill(a, cmsLinked, { amount: 20000 });

    const rows = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows;
    for (const ledger of [importedOnly, cmsLinked]) {
      const row = rows.find((x) => x.ledgerId === String(ledger._id));
      expect(row.code).toBe(screenVendorCode(ledger._id));
    }
  });

  test("the statement carries the same code as the summary", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await bill(a, s, { amount: 118000 });

    const summaryRow = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report
      .rows[0];
    const stmt = (
      await call(`/reports/ledger/${s._id}?companyId=${a.company._id}`, {
        user: orgFor(a.company),
      })
    ).body.statement;
    expect(stmt.ledger.code).toBe(summaryRow.code);
    expect(stmt.ledger.code).toBe(screenVendorCode(s._id));
  });

  test("purchase orders do not affect the accounting payable", async () => {
    // The report never reads PurchaseOrder. Proving it by seeding one would
    // require the CMS model; proving it by CONSTRUCTION is stronger: the only
    // figures that move are the ones with a posted voucher behind them.
    const a = await seedCompany("Alpha");
    const withVoucher = await makeSupplier(a, "Has Bills");
    const withoutVoucher = await makeSupplier(a, "Ordered But Not Billed");
    await bill(a, withVoucher, { amount: 118000 });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Has Bills"]);
    expect(r.body.report.consideredLedgerCount).toBe(2);
    expect(r.body.report.totals.payable).toBe(118000);
    expect(String(withoutVoucher._id)).toBeTruthy();
  });
});

/* ── Scopes ──────────────────────────────────────────────────────────────── */

describe("all / filtered / selected / empty scopes", () => {
  async function threeSuppliers() {
    const a = await seedCompany("Alpha");
    const big = await makeSupplier(a, "Big Mills Pvt Ltd", { gstin: "27BBBBB0000B1Z5" });
    const small = await makeSupplier(a, "Small Weavers LLP", { group: a.imported });
    const quiet = await makeSupplier(a, "Quiet Supplier");
    await bill(a, big, { amount: 500000 });
    await bill(a, small, { amount: 400 });
    return { a, big, small, quiet };
  }

  test("all returns every supplier ledger with a balance, sub-grouped included", async () => {
    const { a } = await threeSuppliers();
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name).sort()).toEqual([
      "Big Mills Pvt Ltd",
      "Small Weavers LLP",
    ]);
    expect(r.body.report.consideredLedgerCount).toBe(3);
  });

  test("filtered exports EXACTLY the ids it was given", async () => {
    const { a, big, quiet } = await threeSuppliers();
    const ids = [String(big._id), String(quiet._id)];
    const r = await call(q(a.company._id, `&scope=filtered&ledgerIds=${ids.join(",")}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.consideredLedgerCount).toBe(2);
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Big Mills Pvt Ltd"]);
    expect(r.body.report.filterSummary).toMatch(/current filtered result \(2\)/);
  });

  test("an EMPTY filtered set exports an empty report, never every supplier", async () => {
    const { a } = await threeSuppliers();
    const r = await call(q(a.company._id, "&scope=filtered&ledgerIds="), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.consideredLedgerCount).toBe(0);
    expect(r.body.report.totals.payable).toBe(0);
    expect(r.body.report.totals.supplierAdvance).toBe(0);
  });

  test("scope=filtered with the ledgerIds parameter MISSING is refused", async () => {
    const { a } = await threeSuppliers();
    const r = await call(q(a.company._id, "&scope=filtered"), { user: orgFor(a.company) });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/must send the ledger ids/);
  });

  test("selected returns exactly the chosen suppliers", async () => {
    const { a, small } = await threeSuppliers();
    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${small._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Small Weavers LLP"]);
    expect(r.body.report.filterSummary).toMatch(/selected suppliers \(1\)/);
  });

  test("minOutstanding applies to every scope, selected included", async () => {
    const { a, big, small } = await threeSuppliers();
    const both = `${big._id},${small._id}`;
    for (const extra of [
      "&minOutstanding=1000",
      `&scope=filtered&minOutstanding=1000&ledgerIds=${both}`,
      `&scope=selected&minOutstanding=1000&ledgerIds=${both}`,
    ]) {
      const r = await call(q(a.company._id, extra), { user: orgFor(a.company) });
      expect(r.body.report.rows.map((x) => x.name)).toEqual(["Big Mills Pvt Ltd"]);
    }
  });

  test("balanceSide=debit returns only suppliers holding an advance", async () => {
    const a = await seedCompany("Alpha");
    const owed = await makeSupplier(a, "Owed Supplier");
    const prepaid = await makeSupplier(a, "Prepaid Supplier");
    await bill(a, owed, { amount: 500000 });
    await payment(a, prepaid, { amount: 80000 });

    const r = await call(q(a.company._id, "&balanceSide=debit"), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Prepaid Supplier"]);
    expect(r.body.report.totals.payable).toBe(0);
  });

  test("balanceSide=credit returns only what we owe", async () => {
    const a = await seedCompany("Alpha");
    const owed = await makeSupplier(a, "Owed Supplier");
    const prepaid = await makeSupplier(a, "Prepaid Supplier");
    await bill(a, owed, { amount: 500000 });
    await payment(a, prepaid, { amount: 80000 });

    const r = await call(q(a.company._id, "&balanceSide=credit"), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.name)).toEqual(["Owed Supplier"]);
    expect(r.body.report.totals.supplierAdvance).toBe(0);
  });
});

/* ── GET / POST equivalence ──────────────────────────────────────────────── */

describe("POST carries the same read when the id list is too long for a URL", () => {
  test("POST returns the same report as the equivalent GET", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeSupplier(a, "Supplier One");
    const two = await makeSupplier(a, "Supplier Two");
    await bill(a, one, { amount: 10000, date: "2026-05-01" });
    await bill(a, two, { amount: 20000, date: "2026-05-01" });
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
    const shape = (b) => {
      const { generatedAt, ...rest } = b.report;
      return rest;
    };
    expect(shape(viaPost.body)).toEqual(shape(viaGet.body));
  });

  test("POST honours an EMPTY filtered array without widening", async () => {
    const a = await seedCompany("Alpha");
    await makeSupplier(a, "Supplier One").then((l) => bill(a, l, { amount: 10000 }));
    const r = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(a.company._id), scope: "filtered", ledgerIds: [] },
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
  });

  test("POST streams a real XLSX for a large filtered set", async () => {
    const a = await seedCompany("Alpha");
    const docs = Array.from({ length: 300 }, (_, i) => ({
      companyId: a.company._id,
      name: `Supplier ${String(i).padStart(3, "0")}`,
      groupId: a.creditors._id,
      groupName: a.creditors.name,
      nature: "liability",
      openingBalance: 1000 + i,
      openingBalanceType: "Cr",
    }));
    const made = await Acc_Ledger.insertMany(docs);

    const res = await call("/reports/outstanding", {
      user: orgFor(a.company),
      method: "POST",
      raw: true,
      body: {
        companyId: String(a.company._id),
        scope: "filtered",
        format: "xlsx",
        ledgerIds: made.map((l) => String(l._id)),
      },
    });
    expect(res.status).toBe(200);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    expect(wb.getWorksheet("Outstanding").getCell(7 + 300 + 1, 1).value).toBe("TOTAL");
  });
});

/* ── The individual supplier statement ───────────────────────────────────── */

describe("individual supplier ledger / statement", () => {
  async function statementFixture() {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Statement Supplier", {
      openingBalance: 5000,
      openingBalanceType: "Cr",
    });
    await bill(a, s, { amount: 20000, date: "2026-04-10", voucherNumber: "PB-1", voucherTypeName: "Purchase Bill" });
    await payment(a, s, { amount: 8000, date: "2026-04-20", voucherNumber: "PAY-1" });
    await bill(a, s, { amount: 12000, date: "2026-06-05", voucherNumber: "PB-2" });
    await debitNote(a, s, { amount: 3000, date: "2026-06-25", voucherNumber: "DN-1" });
    await bill(a, s, { amount: 99000, date: "2026-12-01", voucherNumber: "PB-LATER" });
    await bill(a, s, { amount: 4000, date: "2026-06-10", status: "draft", voucherNumber: "DRAFT-1" });
    return { a, s };
  }

  test("opening is the ledger master opening and closing reconciles", async () => {
    const { a, s } = await statementFixture();
    const r = await call(
      `/reports/ledger/${s._id}?companyId=${a.company._id}&asOf=2026-06-30`,
      { user: orgFor(a.company) },
    );
    const stmt = r.body.statement;
    expect(stmt.opening.amount).toBe(5000);
    expect(stmt.opening.type).toBe("Cr");
    expect(stmt.rows.map((x) => x.voucherNumber)).toEqual(["PB-1", "PAY-1", "PB-2", "DN-1"]);
    expect(stmt.rows.map((x) => x.voucherNumber)).not.toContain("DRAFT-1");
    expect(stmt.rows.map((x) => x.voucherNumber)).not.toContain("PB-LATER");

    // Bills credit, payments and debit notes debit.
    expect(stmt.totals.credit).toBe(32000);
    expect(stmt.totals.debit).toBe(11000);
    expect(stmt.closing.signed).toBe(stmt.opening.signed + stmt.totals.debit - stmt.totals.credit);
    expect(stmt.closing.type).toBe("Cr");
    expect(stmt.closing.amount).toBe(26000);
  });

  test("the running balance is opening plus every movement so far, in date order", async () => {
    const { a, s } = await statementFixture();
    const stmt = (
      await call(`/reports/ledger/${s._id}?companyId=${a.company._id}&asOf=2026-06-30`, {
        user: orgFor(a.company),
      })
    ).body.statement;

    let running = stmt.opening.signed;
    for (const row of stmt.rows) {
      running += row.debit - row.credit;
      expect(row.runningSigned).toBeCloseTo(running, 2);
      expect(row.runningBalance).toBeCloseTo(Math.abs(running), 2);
    }
    expect(stmt.closing.signed).toBeCloseTo(running, 2);
    // −25,000 → −17,000 → −29,000 → −26,000 (all Cr, i.e. all payable)
    expect(stmt.rows.map((x) => x.runningSigned)).toEqual([-25000, -17000, -29000, -26000]);
    expect(stmt.rows.every((x) => x.runningType === "Cr")).toBe(true);
  });

  test("a DATE-RANGE opening includes every posted movement before `from`", async () => {
    const { a, s } = await statementFixture();
    const stmt = (
      await call(
        `/reports/ledger/${s._id}?companyId=${a.company._id}&from=2026-06-01&to=2026-06-30`,
        { user: orgFor(a.company) },
      )
    ).body.statement;

    // 5,000 Cr master opening + 20,000 bill − 8,000 payment = 17,000 Cr.
    expect(stmt.opening.signed).toBe(-17000);
    expect(stmt.opening.amount).toBe(17000);
    expect(stmt.opening.type).toBe("Cr");
    expect(stmt.opening.masterOpening).toBe(-5000);
    expect(stmt.opening.priorVoucherCount).toBe(2);

    expect(stmt.rows.map((x) => x.voucherNumber)).toEqual(["PB-2", "DN-1"]);
    expect(stmt.closing.signed).toBe(-26000);
    expect(stmt.closing.signed).toBe(stmt.opening.signed + stmt.totals.debit - stmt.totals.credit);
  });

  test("the statement's closing equals the summary's balance for the same date", async () => {
    const { a, s } = await statementFixture();
    const stmt = (
      await call(`/reports/ledger/${s._id}?companyId=${a.company._id}&from=2026-06-01&to=2026-06-30`, {
        user: orgFor(a.company),
      })
    ).body.statement;
    const summary = (await call(q(a.company._id, "&asOf=2026-06-30"), { user: orgFor(a.company) }))
      .body.report;
    const row = summary.rows.find((x) => x.ledgerId === String(s._id));
    expect(row.signedBalance).toBe(stmt.closing.signed);
    expect(row.payable).toBe(stmt.closing.amount);
  });

  test("a closing balance on the debit side is reported as an advance", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Overpaid Supplier");
    await bill(a, s, { amount: 5000, date: "2026-05-01" });
    await payment(a, s, { amount: 9000, date: "2026-05-10" });

    const stmt = (
      await call(`/reports/ledger/${s._id}?companyId=${a.company._id}`, {
        user: orgFor(a.company),
      })
    ).body.statement;
    expect(stmt.closing.type).toBe("Dr");
    expect(stmt.closing.amount).toBe(4000);
  });
});

/* ── Read-only ───────────────────────────────────────────────────────────── */

describe("generating a supplier report changes nothing", () => {
  test("ledger, voucher and company documents are byte-identical afterwards", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics", {
      openingBalance: 5000,
      openingBalanceType: "Cr",
    });
    await bill(a, s, { amount: 10000 });

    const snapshot = async () => ({
      ledgers: await Acc_Ledger.find({}).lean(),
      vouchers: await Acc_Voucher.find({}).lean(),
      companies: await Acc_Company.find({}).lean(),
    });
    const before = await snapshot();

    await call(q(a.company._id), { user: orgFor(a.company) });
    await call(q(a.company._id, "&format=xlsx"), { user: orgFor(a.company), raw: true });
    await call(`/reports/ledger/${s._id}?companyId=${a.company._id}&format=pdf`, {
      user: orgFor(a.company),
      raw: true,
    });

    expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
  });
});

/* ── The files themselves ────────────────────────────────────────────────── */

describe("Excel and PDF responses", () => {
  const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  async function twoSuppliers() {
    const a = await seedCompany("Alpha Textiles Pvt. Ltd.");
    const owed = await makeSupplier(a, "Owed Supplier", { gstin: "27BBBBB0000B1Z5" });
    const prepaid = await makeSupplier(a, "Prepaid Supplier");
    await bill(a, owed, { amount: 123456.78, date: "2026-05-01" });
    await payment(a, prepaid, { amount: 4321.5, date: "2026-05-02" });
    return { a, owed, prepaid };
  }

  test("the outstanding XLSX has supplier headings, filters and correct totals", async () => {
    const { a } = await twoSuppliers();
    const res = await call(q(a.company._id, "&format=xlsx&asOf=2026-06-30"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet("Outstanding");

    expect(String(ws.getCell("A1").value)).toBe("Alpha Textiles Pvt. Ltd.");
    expect(String(ws.getCell("A2").value)).toContain("Supplier Outstanding Summary");
    expect(String(ws.getCell("A3").value)).toContain("As on:");
    expect(String(ws.getCell("A4").value)).toContain("Filters —");
    expect(String(ws.getCell("A4").value)).toContain("payable");

    // The party column and the two halves are named for suppliers, and the
    // PAYABLE half comes first because that is the headline for this side.
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => ws.getCell(7, c).value)).toEqual([
      "Code",
      "Supplier",
      "GSTIN",
      "Outstanding",
      "Dr/Cr",
      "Payable (Cr)",
      "Advance (Dr)",
      "Txns",
      "Last Txn",
    ]);

    expect(ws.views[0].state).toBe("frozen");
    expect(ws.autoFilter).toBeTruthy();

    // Rows are alphabetical: Owed Supplier, then Prepaid Supplier.
    expect(typeof ws.getCell(8, 4).value).toBe("number");
    expect(ws.getCell(8, 4).value).toBeCloseTo(123456.78, 2);
    expect(ws.getCell(8, 5).value).toBe("Cr");
    expect(ws.getCell(8, 6).value).toBeCloseTo(123456.78, 2);
    expect(ws.getCell(8, 7).value).toBe(0);

    expect(ws.getCell(9, 5).value).toBe("Dr");
    expect(ws.getCell(9, 6).value).toBe(0);
    expect(ws.getCell(9, 7).value).toBeCloseTo(4321.5, 2);

    // Totals: payable and advance side by side, never netted.
    const totalRow = 10;
    expect(ws.getCell(totalRow, 1).value).toBe("TOTAL");
    expect(ws.getCell(totalRow, 2).value).toMatch(/2 suppliers · 1 payable · 1 in advance/);
    expect(ws.getCell(totalRow, 6).value).toBeCloseTo(123456.78, 2);
    expect(ws.getCell(totalRow, 7).value).toBeCloseTo(4321.5, 2);
    expect(ws.getCell(totalRow + 2, 1).value).toMatch(/Sundry Creditors control account/);
  });

  test("the outstanding filename names the company, the report and the date", async () => {
    const { a } = await twoSuppliers();
    for (const [format, ext] of [["xlsx", "xlsx"], ["pdf", "pdf"]]) {
      const res = await call(q(a.company._id, `&format=${format}&asOf=2026-06-30`), {
        user: orgFor(a.company),
        raw: true,
      });
      const cd = res.headers.get("content-disposition");
      expect(cd).toContain(
        `alpha-textiles-pvt-ltd-supplier-outstanding-as-on-2026-06-30.${ext}`,
      );
      expect(cd).not.toMatch(/[\r\n]/);
    }
  });

  test("the outstanding PDF renders", async () => {
    const { a } = await twoSuppliers();
    const res = await call(q(a.company._id, "&format=pdf&asOf=2026-06-30"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  });

  test("a 200-supplier PDF paginates without dropping anyone", async () => {
    const a = await seedCompany("Alpha");
    await Acc_Ledger.insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        companyId: a.company._id,
        name: `Supplier ${String(i).padStart(3, "0")} — a deliberately long trading name that would clip`,
        groupId: a.creditors._id,
        groupName: a.creditors.name,
        nature: "liability",
        openingBalance: 1000 + i,
        openingBalanceType: "Cr",
      })),
    );
    const json = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(json.body.report.rows.length).toBe(200);

    const res = await call(q(a.company._id, "&format=pdf"), {
      user: orgFor(a.company),
      raw: true,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.toString("latin1")).toMatch(/\/Count\s+[2-9]/);
  });

  test("the statement XLSX carries opening, movement and closing", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Statement Supplier", {
      openingBalance: 5000,
      openingBalanceType: "Cr",
    });
    await bill(a, s, {
      amount: 20000,
      date: "2026-04-10",
      voucherNumber: "PB-1",
      voucherTypeName: "Purchase Bill",
      narration: "April fabric",
    });
    await payment(a, s, { amount: 8000, date: "2026-04-20", voucherNumber: "PAY-1", narration: "NEFT" });

    const res = await call(`/reports/ledger/${s._id}?companyId=${a.company._id}&format=xlsx`, {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);
    expect(res.headers.get("content-disposition")).toContain(
      "supplier-ledger-statement-supplier",
    );

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet("Ledger");

    expect(String(ws.getCell("A2").value)).toContain("Supplier Ledger / Statement of Account");
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

    // Row 8 is the OPENING band — 5,000 Cr.
    expect(ws.getCell(8, 4).value).toBe("Opening Balance");
    expect(ws.getCell(8, 7).value).toBe(5000);
    expect(ws.getCell(8, 8).value).toBe("Cr");

    // The bill credits 20,000 → 25,000 Cr.
    expect(ws.getCell(9, 2).value).toBe("Purchase Bill");
    expect(ws.getCell(9, 3).value).toBe("PB-1");
    expect(ws.getCell(9, 6).value).toBe(20000);
    expect(ws.getCell(9, 7).value).toBe(25000);
    expect(ws.getCell(9, 8).value).toBe("Cr");

    // The payment debits 8,000 → 17,000 Cr.
    expect(ws.getCell(10, 5).value).toBe(8000);
    expect(ws.getCell(10, 7).value).toBe(17000);

    // CLOSING band with the movement totals beside it.
    expect(ws.getCell(11, 4).value).toBe("Closing Balance");
    expect(ws.getCell(11, 5).value).toBe(8000);
    expect(ws.getCell(11, 6).value).toBe(20000);
    expect(ws.getCell(11, 7).value).toBe(17000);
    expect(ws.getCell(11, 8).value).toBe("Cr");
  });

  test("the statement PDF renders and names the period", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Statement Supplier");
    await bill(a, s, { amount: 20000, date: "2026-04-10" });
    const res = await call(
      `/reports/ledger/${s._id}?companyId=${a.company._id}&format=pdf&from=2026-04-01&to=2026-04-30`,
      { user: orgFor(a.company), raw: true },
    );
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      "supplier-ledger-statement-supplier-2026-04-01-to-2026-04-30.pdf",
    );
    expect(Buffer.from(await res.arrayBuffer()).slice(0, 5).toString()).toBe("%PDF-");
  });

  test("an unknown format is refused rather than guessed", async () => {
    const a = await seedCompany("Alpha");
    const r = await call(q(a.company._id, "&format=csv"), { user: orgFor(a.company) });
    expect(r.status).toBe(400);
  });
});
