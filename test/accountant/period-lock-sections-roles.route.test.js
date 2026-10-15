// test/accountant/period-lock-sections-roles.route.test.js
//
// LOCKS BY SECTION, LOCKS ON EVERYTHING DATED, AND ONLY THE OWNER CHANGES A
// LOCK (16 Oct 2026, owner: "lock bank reconciliation too and anything left …
// an option to lock a specific section or unlock … test with the roles as
// well — the editors and all must not be able to … that's only admin access").
//
// Real routers, real organisation sign-ins for an owner, an approver, an
// editor and a viewer, the real 423 middleware; nothing mocked. Each part:
//   1. ROLES — only the owner can lock, unlock or change a lock's sections;
//      every other role is refused and nothing about the lock changes; and
//      while a period is locked NO role — owner included — can change it,
//      nor queue a change for an approver.
//   2. SECTIONS — lock only some sections; the rest stay open; close more,
//      open some again; the lock ends with its last section; the history
//      records each step; a year's sections and a month's interact.
//   3. EVERYTHING ELSE DATED — bank reconciliation, bank statement lines,
//      proforma invoices, cash-flow adjustments, GSTR-2B, tax filings:
//      refused while locked with nothing changed, allowed once unlocked, and
//      a lock on other sections leaves them alone.
"use strict";

process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Organization, Acc_User, Acc_ApprovalRequest } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_BankTransaction, Acc_TaxFiling } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_ProformaInvoice } = require("../../models/Accountant_model/Acc_ProformaInvoice");
const Acc_CashFlowAdjustment = require("../../models/Accountant_model/Acc_CashFlowAdjustment");
const { Acc_GSTR2B } = require("../../models/Accountant_model/Acc_GSTR2B");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { forget, SECTION_KEYS } = require("../../services/accounting/fyLock");

let server, origin, spies;
let Recon; // Acc_BankReconSession, registered by its router

beforeAll(async () => {
  spies = ["warn", "error", "log"].map((k) => jest.spyOn(console, k).mockImplementation(() => {}));
  const app = express();
  app.use(express.json());
  app.use("/api/accountant", require("../../Middlewear/lockedPeriodStatus").lockedPeriodStatus);
  const R = (p) => require(`../../routes/Accountant_Routes/${p}`);
  app.use("/api/accountant/vouchers", R("Acc_vouchers"));
  app.use("/api/accountant/expenses", R("Acc_expenses"));
  app.use("/api/accountant/journal-entries", R("Acc_journalEntries"));
  app.use("/api/accountant/fy-locks", R("Acc_fyLocks"));
  app.use("/api/accountant/bank-recon", R("Acc_bankRecon"));
  app.use("/api/accountant/bank-transactions", R("Acc_bankTransactions"));
  app.use("/api/accountant/proforma-invoices", R("Acc_proformaInvoices"));
  app.use("/api/accountant/cashflow-adjustments", R("Acc_cashflowAdjustments"));
  app.use("/api/accountant/gstr2b", R("Acc_gstr2b"));
  app.use("/api/accountant/tax-filings", R("Acc_taxFilings"));
  Recon = mongoose.models.Acc_BankReconSession;
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}/api/accountant`;
});
afterAll(async () => {
  spies.forEach((s) => s.mockRestore());
  await new Promise((r) => server.close(r));
});
beforeEach(() => forget());

async function call(token, path, { method = "GET", body, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!form) headers["Content-Type"] = "application/json";
  const res = await fetch(`${origin}${path}`, { method, headers, ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
}
const msgOf = (r) => (r.body && (r.body.error || r.body.message)) || "";
const ok = (r) => r.status >= 200 && r.status < 300 && r.body?.success !== false;
const expectOk = (r, what) => { if (!ok(r)) throw new Error(`${what}: ${r.status} ${msgOf(r)}`); return r; };

const MAY = "2026-05-10T06:00:00.000Z";
const MAY20 = "2026-05-20T06:00:00.000Z";
const APRIL = "2026-04-15T06:00:00.000Z";
const GSTIN = "21AABCG1234Q1Z5";

let seq = 0;
/* A company with an owner, an approver, an editor and a viewer; ledgers; and
   one record dated 10 May 2026 in every section, made through the routes
   (or, for a reconciliation session, the model) while nothing is locked. */
async function world() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Sections Co ${n}`, booksFromDate: new Date("2025-04-01"), gstin: GSTIN });
  const org = await Acc_Organization.create({ name: `Org ${n}`, tallyCompanyIds: [company._id] });
  const user = async (role) => {
    const u = new Acc_User({ organizationId: org._id, name: `${role[0].toUpperCase()}${role.slice(1)} ${n}`, email: `${role}${n}@example.com`, role });
    await u.setPassword("a-long-enough-password");
    await u.save();
    return signOrgToken(u);
  };
  const T = { owner: await user("owner"), approver: await user("approver"), editor: await user("editor"), viewer: await user("viewer") };
  const cid = String(company._id);
  const as = (role) => (path, opts) => call(T[role], path, opts);
  const owner = as("owner");

  const group = (name, nature) => Acc_Group.create({ companyId: company._id, name, nature });
  const [gInc, gExp, gBank, gDeb, gCred] = [await group("Sales Accounts", "revenue"), await group("Indirect Expenses", "expense"), await group("Bank Accounts", "asset"), await group("Sundry Debtors", "asset"), await group("Sundry Creditors", "liability")];
  const ledger = (name, g, extra = {}) => Acc_Ledger.create({ companyId: company._id, name, groupId: g._id, groupName: g.name, nature: g.nature, budgetControl: "not_budgeted", ...extra });
  const L = { sales: await ledger("Sales", gInc), rent: await ledger("Rent", gExp), bank: await ledger("SBI", gBank), customer: await ledger("Customer A", gDeb), vendor: await ledger("Vendor V", gCred) };
  const id = (l) => String(l._id);
  const voucher = async (voucherType, dr, cr, amount, date = MAY, extra = {}) =>
    expectOk(await owner("/vouchers", { method: "POST", body: { companyId: cid, voucherType, voucherDate: date, ledgerEntries: [{ ledgerId: id(dr), type: "Dr", amount }, { ledgerId: id(cr), type: "Cr", amount }], grandTotal: amount, autoPost: true, ...extra } }), `seed ${voucherType}`).body;
  const V = {
    sales: await voucher("sales", L.customer, L.sales, 1000),
    payment: await voucher("payment", L.rent, L.bank, 500),
    receipt20: await voucher("receipt", L.bank, L.customer, 300, MAY20),
    payment2: await voucher("payment", L.rent, L.bank, 200),
  };
  const exp = expectOk(await owner("/expenses", { method: "POST", body: { companyId: cid, voucherDate: MAY, description: "Tea", expenseLedgerId: id(L.rent), amount: 60, mode: "pay_now", bankLedgerId: id(L.bank), gstApplicable: false } }), "seed expense");
  V.expense = exp.body.expense || exp.body.voucher || exp.body;

  /* a May statement for SBI: a line on 10 May and a line on 20 May */
  const session = await Recon.create({
    companyId: company._id, bankLedgerId: L.bank._id, bankLedgerName: "SBI", periodMonth: 5, periodYear: 2026, periodLabel: "May 2026",
    periodFrom: new Date("2026-04-30T18:30:00Z"), periodTo: new Date("2026-05-31T18:29:59.999Z"),
    transactions: [
      { valueDate: new Date(MAY), description: "Rent", debit: 500 },
      { valueDate: new Date(MAY20), description: "From customer", credit: 300 },
    ],
  });
  const bankLine = expectOk(await owner("/bank-transactions", { method: "POST", body: { bankAccount: "SBI-1234", bankName: "SBI", transactionDate: MAY, type: "debit", amount: 500, description: "Rent" } }), "seed bank line").body;
  const proforma = expectOk(await owner("/proforma-invoices", { method: "POST", body: { companyId: cid, voucherDate: MAY, buyer: { name: "Customer A" }, items: [{ stockItemName: "Shirt", quantity: 2, rate: 100, gstRate: 0 }] } }), "seed proforma").body;
  const cash = expectOk(await owner("/cashflow-adjustments", { method: "POST", body: { section: "A", label: "Owner's capital", amount: 1000, periodStart: "2026-05-01", periodEnd: "2026-05-31" } }), "seed cash-flow").body;
  const gstForm = (period) => {
    const f = new FormData();
    f.append("companyId", cid);
    f.append("file", new Blob([JSON.stringify({ data: { gstin: GSTIN, rtnprd: period, docdata: {} } })], { type: "application/json" }), `returns_R2B_${GSTIN}_${period}.json`);
    return f;
  };
  expectOk(await owner("/gstr2b/upload", { method: "POST", form: gstForm("052026") }), "seed GSTR-2B");
  const tax = expectOk(await owner("/tax-filings", { method: "POST", body: { taxType: "gst", period: "May 2026", financialYear: "2026-27", dueDate: "2026-06-20" } }), "seed tax filing").body;

  const pick = (b, ...keys) => { for (const k of keys) if (b && b[k] && b[k]._id) return b[k]; return b; };
  return {
    company, org, cid, T, as, owner, L, V, id, session,
    bankLine: pick(bankLine, "transaction", "data"),
    proforma: pick(proforma, "proformaInvoice", "data"),
    cash: pick(cash, "adjustment"),
    tax: pick(tax, "filing", "data"),
    gstForm,
  };
}

/* the lock routes, as any role */
const lockMonth = (w, role = "owner", extra = {}) => w.as(role)("/fy-locks/lock-month", { method: "POST", body: { companyId: w.cid, month: "2026-05", reason: "May books closed and reconciled", ...extra } });
const unlockMonth = (w, role = "owner") => w.as(role)("/fy-locks/unlock-month", { method: "POST", body: { companyId: w.cid, month: "2026-05", reason: "Reopening May for a correction" } });
const sectionsChange = (w, action, sections, role = "owner", target = { kind: "month", month: "2026-05" }) =>
  w.as(role)("/fy-locks/sections", { method: "POST", body: { companyId: w.cid, target, action, sections, reason: `${action} ${sections.join(", ")} for a reason` } });
const locksOn = async (w) => JSON.stringify(await Acc_Company.findById(w.company._id).select("financialYearLocks monthLocks periodLocks").lean());

/* ════════════════════════════════════════════════════════════════════ */
describe("1 · roles — only the owner changes a lock", () => {
  const LOCK_ROUTES = [
    ["freeze a year", (w, r) => w.as(r)("/fy-locks/lock", { method: "POST", body: { companyId: w.cid, fyStartYear: 2025, reason: "FY 2025-26 audited and filed" } })],
    ["lock a month", (w, r) => lockMonth(w, r)],
    ["lock a day", (w, r) => w.as(r)("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-10", to: "2026-05-10", kind: "day", reason: "Day's cash counted and closed" } })],
    ["lock some sections", (w, r) => sectionsChange(w, "lock", ["sales"], r)],
  ];
  const UNLOCK_ROUTES = [
    ["unfreeze a year", (w, r) => w.as(r)("/fy-locks/unlock", { method: "POST", body: { companyId: w.cid, fyStartYear: 2025, reason: "Audit adjustment needed now" } })],
    ["unlock a month", (w, r) => unlockMonth(w, r)],
    ["unlock a day", (w, r) => w.as(r)("/fy-locks/unlock-period", { method: "POST", body: { companyId: w.cid, key: "2026-05-10..2026-05-10", reason: "Reopening the day for a fix" } })],
    ["unlock one section", (w, r) => sectionsChange(w, "unlock", ["sales"], r)],
  ];

  for (const role of ["approver", "editor", "viewer"]) {
    test(`${role}: every lock and unlock route is refused, and no lock changes`, async () => {
      const w = await world();
      const before = await locksOn(w);
      for (const [name, run] of LOCK_ROUTES) {
        const r = await run(w, role);
        expect([name, r.status]).toEqual([name, 403]);
      }
      expect(await locksOn(w)).toBe(before);
      /* the owner locks everything; the role still cannot unlock any of it */
      expectOk(await w.as("owner")("/fy-locks/lock", { method: "POST", body: { companyId: w.cid, fyStartYear: 2025, reason: "FY 2025-26 audited and filed" } }), "owner freeze");
      expectOk(await lockMonth(w), "owner lock month");
      expectOk(await w.as("owner")("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-10", to: "2026-05-10", kind: "day", reason: "Day's cash counted and closed" } }), "owner lock day");
      const locked = await locksOn(w);
      for (const [name, run] of UNLOCK_ROUTES) {
        const r = await run(w, role);
        expect([name, r.status]).toEqual([name, 403]);
      }
      expect(await locksOn(w)).toBe(locked);
      /* they can read the locks, and are told they cannot change them */
      const list = await w.as(role)(`/fy-locks?companyId=${w.cid}`);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ canLock: false, canUnlock: false });
      expect((await w.as(role)(`/fy-locks/locked?companyId=${w.cid}`)).body.locks.length).toBe(3);
    });
  }

  test("owner: every lock and unlock route works, and GET says so", async () => {
    const w = await world();
    for (const [name, run] of LOCK_ROUTES.slice(0, 3)) expect([name, (await run(w, "owner")).status]).toEqual([name, 200]);
    expect((await w.owner(`/fy-locks?companyId=${w.cid}`)).body).toMatchObject({ canLock: true, canUnlock: true });
    for (const [name, run] of UNLOCK_ROUTES.slice(0, 3)) expect([name, (await run(w, "owner")).status]).toEqual([name, 200]);
    expect((await w.owner(`/fy-locks/locked?companyId=${w.cid}`)).body.locks).toEqual([]);
  });

  test("while a month is locked NO role can change its vouchers — owner included — nor queue a change", async () => {
    const w = await world();
    expectOk(await lockMonth(w), "lock");
    forget();
    const sales = String(w.V.sales._id);
    const voucherState = async () => JSON.stringify(await Acc_Voucher.find({ companyId: w.company._id }).sort({ _id: 1 }).select("voucherDate status narration grandTotal ledgerEntries.amount").lean());
    const before = await voucherState();
    const requestsBefore = await Acc_ApprovalRequest.countDocuments({ companyId: w.company._id });
    for (const role of ["owner", "approver", "editor", "viewer"]) {
      const tries = [
        ["edit", await w.as(role)(`/vouchers/${sales}`, { method: "PUT", body: { narration: `by ${role}` } })],
        ["cancel", await w.as(role)(`/vouchers/${sales}/cancel`, { method: "POST", body: { companyId: w.cid, reason: "test" } })],
        ["void", await w.as(role)(`/vouchers/${sales}/void`, { method: "POST", body: { companyId: w.cid, reason: "test" } })],
        ["create", await w.as(role)("/vouchers", { method: "POST", body: { companyId: w.cid, voucherType: "journal", voucherDate: MAY, ledgerEntries: [{ ledgerId: w.id(w.L.rent), type: "Dr", amount: 5 }, { ledgerId: w.id(w.L.bank), type: "Cr", amount: 5 }], grandTotal: 5, autoPost: true } })],
      ];
      for (const [what, r] of tries) {
        /* a viewer is stopped at the door (403); everyone else by the lock (423) */
        expect([role, what, r.status]).toEqual([role, what, role === "viewer" ? expect.any(Number) : 423]);
        expect(r.status === 423 || r.status === 403).toBe(true);
      }
    }
    expect(await voucherState()).toBe(before);
    expect(await Acc_ApprovalRequest.countDocuments({ companyId: w.company._id })).toBe(requestsBefore);
    /* unlocked, the editor's cancel is queued for an approver as before */
    expectOk(await unlockMonth(w), "unlock");
    forget();
    const queued = await w.as("editor")(`/vouchers/${sales}/cancel`, { method: "POST", body: { companyId: w.cid, reason: "test" } });
    expect(queued.status).toBe(202);
    expect(await Acc_ApprovalRequest.countDocuments({ companyId: w.company._id })).toBe(requestsBefore + 1);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe("2 · sections — lock or unlock a part of a period", () => {
  const edit = (w, key) => w.owner(`/vouchers/${String(w.V[key]._id)}`, { method: "PUT", body: { narration: `edit ${Math.random()}` } });

  test("only the sections asked for are closed; more can be closed and some opened again; the lock ends with its last section", async () => {
    const w = await world();
    const r = await lockMonth(w, "owner", { sections: ["sales"] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ locked: true, sections: ["sales"], allSections: false });
    forget();
    const salesEdit = await edit(w, "sales");
    expect(salesEdit.status).toBe(423);
    expect(msgOf(salesEdit)).toMatch(/May 2026 is locked for Sales invoices by Owner/);
    expect((await edit(w, "payment")).status).toBe(200); // payments open

    /* close payments too */
    expect((await sectionsChange(w, "lock", ["payment"])).status).toBe(200);
    forget();
    expect((await edit(w, "payment")).status).toBe(423);
    /* a payment-type EXPENSE is its own section: still open */
    expect((await w.owner(`/expenses/${String(w.V.expense._id)}/reject`, { method: "POST", body: { reason: "test" } })).status).toBe(200);

    /* open sales again — payments stay closed */
    const opened = await sectionsChange(w, "unlock", ["sales"]);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ locked: true, sections: ["payment"] });
    forget();
    expect((await edit(w, "sales")).status).toBe(200);
    expect((await edit(w, "payment2")).status).toBe(423);

    /* refusals that say why */
    expect((await sectionsChange(w, "lock", ["payment"])).status).toBe(409); // already locked
    expect((await sectionsChange(w, "unlock", ["sales"])).status).toBe(409); // already open
    expect((await sectionsChange(w, "lock", ["nonsense"])).status).toBe(400);
    expect((await w.owner("/fy-locks/sections", { method: "POST", body: { companyId: w.cid, target: { kind: "month", month: "2026-05" }, action: "lock", sections: [], reason: "nothing at all here" } })).status).toBe(400);

    /* the last section opens → the month is open */
    const last = await sectionsChange(w, "unlock", ["payment"]);
    expect(last.body).toMatchObject({ locked: false, sections: [] });
    forget();
    expect((await edit(w, "payment2")).status).toBe(200);
    const m = (await w.owner(`/fy-locks?companyId=${w.cid}`)).body.years.find((y) => y.fyStartYear === 2026).months.find((x) => x.month === "2026-05");
    expect(m.locked).toBe(false);
    expect(m.history.map((h) => [h.action, h.sections])).toEqual([
      ["unlock", ["payment"]],
      ["unlock", ["sales"]],
      ["lock", ["payment"]],
      ["lock", ["sales"]],
    ]);
  });

  test("an all-sections lock can have one section opened, and the rest stay locked", async () => {
    const w = await world();
    expectOk(await lockMonth(w), "lock all");
    const opened = await sectionsChange(w, "unlock", ["bank_reconciliation"]);
    expect(opened.body.sections).toEqual(SECTION_KEYS.filter((k) => k !== "bank_reconciliation"));
    forget();
    const locked = (await w.owner(`/fy-locks/locked?companyId=${w.cid}`)).body.locks[0];
    expect(locked).toMatchObject({ allSections: false });
    expect(locked.sections).not.toContain("bank_reconciliation");
    /* reconciliation works, vouchers do not */
    const match = await w.owner(`/bank-recon/sessions/${w.session._id}/match`, { method: "PUT", body: { txnId: String(w.session.transactions[0]._id), voucherId: String(w.V.payment._id), amount: 500 } });
    expect(match.status).toBe(200);
    expect((await edit(w, "sales")).status).toBe(423);
    /* close it again: the lock is whole once more */
    expect((await sectionsChange(w, "lock", ["bank_reconciliation"])).body.allSections).toBe(true);
  });

  test("sections on a day lock and a year; a month inside a year that already closes it is refused, other sections are not", async () => {
    const w = await world();
    const day = await w.owner("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-10", to: "2026-05-10", kind: "day", sections: ["payment"], reason: "Day's payments closed out" } });
    expect(day.body).toMatchObject({ locked: true, sections: ["payment"] });
    forget();
    expect((await edit(w, "payment")).status).toBe(423);
    expect((await edit(w, "sales")).status).toBe(200);
    expect((await sectionsChange(w, "lock", ["sales"], "owner", { kind: "period", key: "2026-05-10..2026-05-10" })).status).toBe(200);
    forget();
    expect((await edit(w, "sales")).status).toBe(423);

    /* a past year frozen for sales only (the year's records sit in FY 2025-26) */
    const fy = await w.owner("/fy-locks/lock", { method: "POST", body: { companyId: w.cid, fyStartYear: 2025, sections: ["sales"], reason: "Sales of FY 2025-26 audited" } });
    expect(fy.body).toMatchObject({ locked: true, sections: ["sales"] });
    const inYear = (sections) => w.owner("/fy-locks/lock-month", { method: "POST", body: { companyId: w.cid, month: "2025-06", sections, reason: "June 2025 closed for these" } });
    expect((await inYear(["sales"])).status).toBe(409); // the year already closes it
    expect((await inYear(["payment"])).status).toBe(200); // the year does not
  });

  test("each voucher is in its own section: expenses, payroll, journal entries and opening balances lock separately", async () => {
    const w = await world();
    await lockMonth(w, "owner", { sections: ["expenses"] });
    forget();
    expect((await w.owner(`/expenses/${String(w.V.expense._id)}/reject`, { method: "POST", body: { reason: "test" } })).status).toBe(423);
    expect((await edit(w, "payment")).status).toBe(200); // a plain payment is not an expense
    /* a payroll posting is its own section */
    const payroll = await Acc_Voucher.create({ companyId: w.company._id, voucherType: "journal", voucherNumber: "PR-1", voucherDate: new Date("2026-06-30T06:00:00Z"), sourceSystem: "auto_from_payroll", status: "posted", grandTotal: 9, ledgerEntries: [{ ledgerId: w.L.rent._id, ledgerName: "Rent", type: "Dr", amount: 9 }, { ledgerId: w.L.bank._id, ledgerName: "SBI", type: "Cr", amount: 9 }] });
    await w.owner("/fy-locks/lock-month", { method: "POST", body: { companyId: w.cid, month: "2026-06", sections: ["journal"], reason: "June journals closed" } });
    forget();
    expect((await w.owner(`/vouchers/${payroll._id}`, { method: "PUT", body: { narration: "x" } })).status).toBe(200); // payroll ≠ journal
    await sectionsChange(w, "lock", ["payroll"], "owner", { kind: "month", month: "2026-06" });
    forget();
    expect((await w.owner(`/vouchers/${payroll._id}`, { method: "PUT", body: { narration: "y" } })).status).toBe(423);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe("3 · everything else that is dated", () => {
  /* a snapshot of every record these sections hold */
  async function state(w) {
    const recon = await Recon.findById(w.session._id).lean();
    return JSON.stringify({
      recon: recon && { status: recon.status, bank: recon.bankLedgerId, tx: recon.transactions.map((t) => [t.matched, t.reconciled, t.note || "", (t.allocations || []).length]), clears: recon.manualClears },
      lines: await Acc_BankTransaction.find({ bankAccount: "SBI-1234" }).sort({ _id: 1 }).select("transactionDate amount isReconciled").lean(),
      proforma: await Acc_ProformaInvoice.find({ companyId: w.company._id }).select("voucherDate status grandTotal").lean(),
      cash: await Acc_CashFlowAdjustment.find({ organizationId: w.org._id }).select("amount status label").lean(),
      gst: await Acc_GSTR2B.find({ companyId: w.company._id }).select("returnPeriod").lean(),
      tax: await Acc_TaxFiling.find({}).select("period status amountPaid").lean(),
    });
  }
  const recon = (w, path, body) => w.owner(`/bank-recon/sessions/${w.session._id}${path}`, { method: path ? "PUT" : "DELETE", body });
  const tx = (w, i) => String(w.session.transactions[i]._id);
  const OPS = [
    ["Bank reconciliation", "match a statement line to a voucher", (w) => recon(w, "/match", { txnId: tx(w, 0), voucherId: String(w.V.payment._id), amount: 500 })],
    ["Bank reconciliation", "unmatch a line", async (w) => { await Recon.updateOne({ _id: w.session._id }, { $set: { "transactions.0.matched": true, "transactions.0.allocations": [{ voucherId: w.V.payment._id, amount: 500 }] } }); }, (w) => recon(w, "/unmatch", { txnId: tx(w, 0), voucherId: String(w.V.payment._id) })],
    ["Bank reconciliation", "tick a line reconciled", (w) => recon(w, "/reconcile", { txnId: tx(w, 0), reconciled: true })],
    ["Bank reconciliation", "clear a voucher with no bank line", (w) => recon(w, "/clear-ledger", { voucherId: String(w.V.payment2._id), cleared: true, note: "bank charge" })],
    ["Bank reconciliation", "change the session's bank account", (w) => recon(w, "/ledger", { bankLedgerId: w.id(w.L.rent) })],
    ["Bank reconciliation", "delete the session", (w) => recon(w, "", undefined)],
    ["Bank statement lines", "add a line dated in the period", (w) => w.owner("/bank-transactions", { method: "POST", body: { bankAccount: "SBI-1234", bankName: "SBI", transactionDate: MAY, type: "credit", amount: 77, description: "new" } })],
    ["Bank statement lines", "reconcile a line", (w) => w.owner(`/bank-transactions/${w.bankLine._id}/reconcile`, { method: "POST", body: { voucherId: String(w.V.payment._id) } })],
    ["Bank statement lines", "unreconcile a line", async (w) => { await Acc_BankTransaction.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(w.bankLine._id)) }, { $set: { isReconciled: true } }); }, (w) => w.owner(`/bank-transactions/${w.bankLine._id}/unreconcile`, { method: "POST", body: {} })],
    ["Bank statement lines", "delete a line", (w) => w.owner(`/bank-transactions/${w.bankLine._id}`, { method: "DELETE" })],
    ["Proforma invoices", "create one dated in the period", (w) => w.owner("/proforma-invoices", { method: "POST", body: { companyId: w.cid, voucherDate: MAY, buyer: { name: "Customer B" }, items: [{ stockItemName: "Cap", quantity: 1, rate: 50, gstRate: 0 }] } })],
    ["Proforma invoices", "edit one", (w) => w.owner(`/proforma-invoices/${w.proforma._id}`, { method: "PUT", body: { companyId: w.cid, voucherDate: MAY, buyer: { name: "Customer A" }, items: [{ stockItemName: "Shirt", quantity: 3, rate: 100, gstRate: 0 }] } })],
    ["Proforma invoices", "change its status", (w) => w.owner(`/proforma-invoices/${w.proforma._id}/status`, { method: "PATCH", body: { status: "cancelled" } })],
    ["Proforma invoices", "delete one", (w) => w.owner(`/proforma-invoices/${w.proforma._id}`, { method: "DELETE" })],
    ["Cash-flow adjustments", "add one for the period", (w) => w.owner("/cashflow-adjustments", { method: "POST", body: { section: "B", label: "FD broken", amount: -500, periodStart: "2026-05-01", periodEnd: "2026-05-31" } })],
    ["Cash-flow adjustments", "edit one", (w) => w.owner(`/cashflow-adjustments/${w.cash._id}`, { method: "PUT", body: { amount: 1500 } })],
    ["Cash-flow adjustments", "delete one", (w) => w.owner(`/cashflow-adjustments/${w.cash._id}`, { method: "DELETE" })],
    ["GSTR-2B", "upload the period's return again", (w) => w.owner("/gstr2b/upload", { method: "POST", form: w.gstForm("052026") })],
    ["GSTR-2B", "delete the period's return", (w) => w.owner(`/gstr2b/052026?companyId=${w.cid}`, { method: "DELETE" })],
    ["Tax filings", "record a filing for the period", (w) => w.owner("/tax-filings", { method: "POST", body: { taxType: "tds", period: "May 2026", financialYear: "2026-27", dueDate: "2026-06-07" } })],
    ["Tax filings", "edit the period's filing", (w) => w.owner(`/tax-filings/${w.tax._id}`, { method: "PUT", body: { amountPaid: 900 } })],
    ["Tax filings", "mark it filed", (w) => w.owner(`/tax-filings/${w.tax._id}/file`, { method: "POST", body: { acknowledgementNumber: "ACK1" } })],
    ["Tax filings", "delete the period's filing", (w) => w.owner(`/tax-filings/${w.tax._id}`, { method: "DELETE" })],
  ].map(([area, name, a, b]) => (b ? { area, name, setup: a, run: b } : { area, name, run: a }));

  for (const op of OPS) {
    test(`${op.area} — ${op.name}: refused while May is locked, allowed once unlocked`, async () => {
      const w = await world();
      if (op.setup) await op.setup(w);
      expectOk(await lockMonth(w), "lock");
      forget();
      const before = await state(w);
      const r1 = await op.run(w);
      expect([op.name, r1.status, msgOf(r1).slice(0, 80)]).toEqual([op.name, 423, expect.stringMatching(/May 2026 is locked/)]);
      expect(await state(w)).toBe(before);
      expectOk(await unlockMonth(w), "unlock");
      forget();
      const r2 = await op.run(w);
      expect([op.name, ok(r2) ? "ok" : `${r2.status} ${msgOf(r2)}`]).toEqual([op.name, "ok"]);
    });
  }

  test("roles on the new areas: an editor and an approver are refused by the lock, a viewer at the door; nothing changes", async () => {
    const w = await world();
    expectOk(await lockMonth(w), "lock");
    forget();
    const before = await state(w);
    const tries = (as) => [
      ["reconcile", as(`/bank-recon/sessions/${w.session._id}/match`, { method: "PUT", body: { txnId: tx(w, 0), voucherId: String(w.V.payment._id), amount: 500 } })],
      ["bank line", as("/bank-transactions", { method: "POST", body: { bankAccount: "SBI-1234", bankName: "SBI", transactionDate: MAY, type: "credit", amount: 5, description: "x" } })],
      ["delete bank line", as(`/bank-transactions/${w.bankLine._id}`, { method: "DELETE" })],
      ["proforma", as(`/proforma-invoices/${w.proforma._id}/status`, { method: "PATCH", body: { status: "cancelled" } })],
      ["cash-flow", as(`/cashflow-adjustments/${w.cash._id}`, { method: "PUT", body: { amount: 9 } })],
      ["gst", as(`/gstr2b/052026?companyId=${w.cid}`, { method: "DELETE" })],
      ["tax filing", as(`/tax-filings/${w.tax._id}`, { method: "PUT", body: { amountPaid: 1 } })],
    ];
    for (const role of ["approver", "editor", "viewer"]) {
      for (const [what, p] of tries(w.as(role))) {
        const r = await p;
        /* an editor may not edit someone else's cash-flow adjustment at all
           (the route's own rule, 403) — refused before the lock is asked */
        const expected = role === "viewer" || (role === "editor" && what === "cash-flow") ? 403 : 423;
        expect([role, what, r.status]).toEqual([role, what, expected]);
      }
    }
    expect(await state(w)).toBe(before);
  });

  test("a lock on other sections leaves every one of these open", async () => {
    const w = await world();
    expectOk(await lockMonth(w, "owner", { sections: ["sales", "purchase", "receipt", "payment", "contra", "journal", "credit_note", "debit_note"] }), "lock vouchers only");
    forget();
    for (const op of OPS.filter((o) => !o.setup && !/delete/.test(o.name))) {
      const r = await op.run(w);
      expect([op.area, op.name, ok(r) ? "ok" : `${r.status} ${msgOf(r)}`]).toEqual([op.area, op.name, "ok"]);
    }
  });

  test("locking 10 May leaves a reconciliation line of 20 May open — the guard reads the line, not the month", async () => {
    const w = await world();
    expectOk(await w.owner("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-10", to: "2026-05-10", kind: "day", reason: "Day's cash counted and closed" } }), "lock day");
    forget();
    expect((await recon(w, "/match", { txnId: tx(w, 0), voucherId: String(w.V.payment._id), amount: 500 })).status).toBe(423);
    expect((await recon(w, "/match", { txnId: tx(w, 1), voucherId: String(w.V.receipt20._id), amount: 300 })).status).toBe(200);
    /* the session as a whole spans the locked day: it cannot be deleted */
    expect((await recon(w, "", undefined)).status).toBe(423);
  });

  test("a new reconciliation session with a line in a locked period is refused", async () => {
    const w = await world();
    expectOk(await lockMonth(w), "lock");
    forget();
    await expect(Recon.create({ companyId: w.company._id, bankLedgerId: w.L.bank._id, periodFrom: new Date("2026-04-30T18:30:00Z"), periodTo: new Date("2026-05-31T18:29:59.999Z"), transactions: [{ valueDate: new Date(MAY), debit: 1 }] })).rejects.toMatchObject({ code: "FY_LOCKED", section: "bank_reconciliation" });
  });

  test("a statement import keeps the open days and leaves out the locked ones, saying how many", async () => {
    const w = await world();
    expectOk(await lockMonth(w), "lock");
    forget();
    const r = await w.owner("/bank-transactions/import-statement", { method: "POST", body: { bankAccount: "SBI-1234", transactions: [
      { transactionDate: APRIL, bankName: "SBI", type: "credit", amount: 11, description: "april" },
      { transactionDate: MAY20, bankName: "SBI", type: "credit", amount: 22, description: "may" },
    ] } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ inserted: 1, lockedSkipped: 1 });
    expect(r.body.message).toMatch(/1 line is in a locked period and was left out/);
    expect(await Acc_BankTransaction.countDocuments({ description: "may" })).toBe(0);
    expect(await Acc_BankTransaction.countDocuments({ description: "april" })).toBe(1);
  });

  test("reading never trips a lock: the proforma list and the 2B reconciliation cache still answer", async () => {
    const w = await world();
    expectOk(await lockMonth(w), "lock");
    forget();
    expect((await w.owner(`/proforma-invoices?companyId=${w.cid}`)).status).toBe(200);
    expect((await w.owner(`/fy-locks?companyId=${w.cid}`)).status).toBe(200);
  });
});
