// test/accountant/period-lock-simulation.route.test.js
//
// EVERY WAY TO CHANGE THE BOOKS, AGAINST A LOCKED PERIOD (15 Oct 2026, owner:
// "simulate all the editing features from ledgers to every single voucher and
// tell me if we can actually edit or not when the period is locked and not
// locked … check all edit / remove / void / cancel options").
//
// For each operation: build fresh books (a company, its ledgers and one of
// every voucher type dated 10 May 2026, made through the real routes), lock
// the period through the real /fy-locks routes, try the operation, and check
//   • it is refused 423 FY_LOCKED with the lock named, and
//   • NOTHING moved — every voucher and every ledger balance is byte-for-byte
//     what it was;
// then unlock (with a reason, as the owner) and try the SAME operation again:
// it must now go through. A handful of operations are meant to work on a
// locked period (a payment reminder, a ledger rename, receiving money in an
// open month against a locked month's invoice …) and are checked the other
// way round.
//
// The real routers, the real org sign-in (an owner's bearer token) and the
// real 423 middleware are used; nothing is mocked. The result table is
// written to $LOCK_REPORT when that is set.
"use strict";

process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const fs = require("fs");
const express = require("express");
const mongoose = require("mongoose");

const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_JournalEntry } = require("../../models/Accountant_model/Acc_OperationalModels");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { forget } = require("../../services/accounting/fyLock");

let server, origin, warnSpy, errSpy, logSpy;
const REPORT = [];

beforeAll(async () => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const app = express();
  app.use(express.json());
  app.use("/api/accountant", require("../../Middlewear/lockedPeriodStatus").lockedPeriodStatus);
  const R = (p) => require(`../../routes/Accountant_Routes/${p}`);
  app.use("/api/accountant/vouchers", R("Acc_vouchers"));
  app.use("/api/accountant/invoices", R("Acc_invoices"));
  app.use("/api/accountant/expenses", R("Acc_expenses"));
  app.use("/api/accountant/journal-entries", R("Acc_journalEntries"));
  app.use("/api/accountant/chart-of-accounts", R("Acc_chartOfAccounts"));
  app.use("/api/accountant/merge", R("Acc_merge"));
  app.use("/api/accountant/tally/companies", R("Acc_companies"));
  app.use("/api/accountant/fy-locks", R("Acc_fyLocks"));
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}/api/accountant`;
});
afterAll(async () => {
  warnSpy.mockRestore();
  errSpy.mockRestore();
  logSpy.mockRestore();
  await new Promise((r) => server.close(r));
  if (process.env.LOCK_REPORT) fs.writeFileSync(process.env.LOCK_REPORT, JSON.stringify(REPORT, null, 2));
});
beforeEach(() => forget());

let seq = 0;
async function call(token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
}
const msgOf = (r) => (r.body && (r.body.error || r.body.message)) || "";
const ok = (r) => r.status >= 200 && r.status < 300 && r.body?.success !== false;

const MAY = "2026-05-10T06:00:00.000Z";
const JUNE = "2026-06-10T06:00:00.000Z";

/* ── a company, an owner, ledgers and one posted voucher of every type ─── */
async function world(date = MAY) {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Lock Co ${n}`, booksFromDate: new Date("2025-04-01") });
  const org = await Acc_Organization.create({ name: `Org ${n}`, tallyCompanyIds: [company._id] });
  const owner = new Acc_User({ organizationId: org._id, name: `Owner ${n}`, email: `owner${n}@example.com`, role: "owner" });
  await owner.setPassword("a-long-enough-password");
  await owner.save();
  const token = signOrgToken(owner);
  const cid = String(company._id);

  const group = async (name, nature) => Acc_Group.create({ companyId: company._id, name, nature });
  const gInc = await group("Sales Accounts", "revenue");
  const gExp = await group("Indirect Expenses", "expense");
  const gPur = await group("Purchase Accounts", "expense");
  const gBank = await group("Bank Accounts", "asset");
  const gCash = await group("Cash-in-Hand", "asset");
  const gDeb = await group("Sundry Debtors", "asset");
  const gCred = await group("Sundry Creditors", "liability");
  const ledger = async (name, g, extra = {}) =>
    Acc_Ledger.create({ companyId: company._id, name, groupId: g._id, groupName: g.name, nature: g.nature, budgetControl: "not_budgeted", ...extra }); // budgets are not under test
  const L = {
    sales: await ledger("Sales", gInc),
    purchase: await ledger("Purchases", gPur),
    rent: await ledger("Rent", gExp),
    rent2: await ledger("Rent (old)", gExp),
    bank: await ledger("SBI", gBank),
    cash: await ledger("Cash", gCash),
    customer: await ledger("Customer A", gDeb, { isParty: true }),
    vendor: await ledger("Vendor V", gCred, { isParty: true }),
  };
  const id = (l) => String(l._id);
  const entries = (dr, cr, amount) => [
    { ledgerId: id(dr), ledgerName: dr.name, type: "Dr", amount },
    { ledgerId: id(cr), ledgerName: cr.name, type: "Cr", amount },
  ];
  const make = async (voucherType, dr, cr, amount, extra = {}) => {
    const r = await call(token, "/vouchers", {
      method: "POST",
      body: { companyId: cid, voucherType, voucherDate: extra.voucherDate || date, ledgerEntries: entries(dr, cr, amount), grandTotal: amount, autoPost: extra.draft ? false : true, narration: `${voucherType} seed`, ...extra.body },
    });
    if (r.status !== 201) throw new Error(`seed ${voucherType}: ${r.status} ${msgOf(r)}`);
    return r.body;
  };
  const V = {
    sales: await make("sales", L.customer, L.sales, 11800, { body: { partyLedgerId: id(L.customer) } }),
    purchase: await make("purchase", L.purchase, L.vendor, 5000, { body: { partyLedgerId: id(L.vendor) } }),
    receipt: await make("receipt", L.bank, L.customer, 3000, { body: { partyLedgerId: id(L.customer) } }),
    payment: await make("payment", L.vendor, L.bank, 2000, { body: { partyLedgerId: id(L.vendor) } }),
    contra: await make("contra", L.cash, L.bank, 1000),
    journal: await make("journal", L.rent, L.cash, 500),
    credit_note: await make("credit_note", L.sales, L.customer, 1180, { body: { partyLedgerId: id(L.customer) } }),
    debit_note: await make("debit_note", L.vendor, L.purchase, 700, { body: { partyLedgerId: id(L.vendor) } }),
    draft: await make("journal", L.rent, L.bank, 250, { draft: true }),
  };
  const je = await call(token, "/journal-entries", {
    method: "POST",
    body: { companyId: cid, entryDate: date, narration: "JE draft", type: "adjusting", lines: [{ accountCode: id(L.rent), accountName: "Rent", debit: 400, credit: 0 }, { accountCode: id(L.cash), accountName: "Cash", debit: 0, credit: 400 }] },
  });
  if (!ok(je) && je.status !== 201) throw new Error(`seed journal entry: ${je.status} ${msgOf(je)}`);
  const jePosted = await call(token, "/journal-entries", {
    method: "POST",
    body: { companyId: cid, entryDate: date, narration: "JE posted", type: "adjusting", postImmediately: true, lines: [{ accountCode: id(L.rent), accountName: "Rent", debit: 300, credit: 0 }, { accountCode: id(L.bank), accountName: "SBI", debit: 0, credit: 300 }] },
  });
  const exp = await call(token, "/expenses", {
    method: "POST",
    body: { companyId: cid, voucherDate: date, description: "Office tea", expenseLedgerId: id(L.rent), amount: 600, mode: "pay_now", bankLedgerId: id(L.bank), gstApplicable: false },
  });
  if (!ok(exp) && exp.status !== 201) throw new Error(`seed expense: ${exp.status} ${msgOf(exp)}`);
  const pick = (r) => r.body?.entry || r.body?.data || r.body;
  return {
    token, cid, company, L, V, id,
    date, // inside the period under test
    open: date === MAY ? JUNE : MAY, // a day no lock under test covers
    je: pick(je), jePosted: pick(jePosted),
    expense: exp.body?.expense || exp.body?.voucher || exp.body,
    call: (path, opts) => call(token, path, opts),
  };
}

/* Everything that would show a change: vouchers, journal entries, ledgers. */
async function snapshot(companyId) {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const vouchers = await Acc_Voucher.find({ companyId: cid }).sort({ _id: 1 })
    .select("voucherType voucherNumber voucherDate status narration grandTotal partyLedgerId ledgerEntries.ledgerId ledgerEntries.type ledgerEntries.amount ledgerEntries.billAllocations inventoryEntries")
    .lean();
  const jes = await Acc_JournalEntry.find({ companyId: cid }).sort({ _id: 1 }).select("entryDate status narration lines.debit lines.credit lines.ledgerId").lean();
  const ledgers = await Acc_Ledger.find({ companyId: cid }).sort({ _id: 1 }).select("name groupId currentBalance openingBalance openingBalanceType isActive").lean();
  return JSON.stringify({ vouchers, jes, ledgers });
}

/* ── the locks, through the real routes ──────────────────────────────── */
const LOCKS = {
  month: { lock: (w) => w.call("/fy-locks/lock-month", { method: "POST", body: { companyId: w.cid, month: "2026-05", reason: "May books closed and reconciled" } }),
           unlock: (w) => w.call("/fy-locks/unlock-month", { method: "POST", body: { companyId: w.cid, month: "2026-05", reason: "Reopening May for a correction" } }) },
  year: { lock: (w) => w.call("/fy-locks/lock", { method: "POST", body: { companyId: w.cid, fyStartYear: 2025, reason: "FY 2025-26 audited and filed" } }),
          unlock: (w) => w.call("/fy-locks/unlock", { method: "POST", body: { companyId: w.cid, fyStartYear: 2025, reason: "Audit adjustment needed" } }) },
  day: { lock: (w) => w.call("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-10", to: "2026-05-10", kind: "day", reason: "Day's cash counted and closed" } }),
         unlock: (w) => w.call("/fy-locks/unlock-period", { method: "POST", body: { companyId: w.cid, key: "2026-05-10..2026-05-10", reason: "Reopening the day for a fix" } }) },
  week: { lock: (w) => w.call("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-04", to: "2026-05-10", kind: "week", reason: "Week closed with the bank" } }),
          unlock: (w) => w.call("/fy-locks/unlock-period", { method: "POST", body: { companyId: w.cid, key: "2026-05-04..2026-05-10", reason: "Reopening the week for a fix" } }) },
  range: { lock: (w) => w.call("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2026-05-01", to: "2026-05-20", kind: "range", reason: "GST period 1-20 May filed" } }),
           unlock: (w) => w.call("/fy-locks/unlock-period", { method: "POST", body: { companyId: w.cid, key: "2026-05-01..2026-05-20", reason: "Reopening the range for a fix" } }) },
  upto: { lock: (w) => w.call("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, from: "2025-04-01", to: "2026-05-31", kind: "upto", reason: "Everything to May is final" } }),
          unlock: (w) => w.call("/fy-locks/unlock-period", { method: "POST", body: { companyId: w.cid, key: "2025-04-01..2026-05-31", reason: "Reopening for a correction" } }) },
};

/* ── the operations ─────────────────────────────────────────────────────
   `area` groups the report; `run` performs it once on a world. */
const v = (w, k) => String(w.V[k]._id);
const VOUCHER_KINDS = ["sales", "purchase", "receipt", "payment", "contra", "journal", "credit_note", "debit_note"];
const OPS = [];
for (const k of VOUCHER_KINDS) {
  OPS.push({ area: `Voucher · ${k}`, name: "create a new one dated in the period", run: (w) => w.call("/vouchers", { method: "POST", body: { companyId: w.cid, voucherType: k, voucherDate: w.date, ledgerEntries: [{ ledgerId: w.id(w.L.rent), type: "Dr", amount: 10 }, { ledgerId: w.id(w.L.cash), type: "Cr", amount: 10 }], grandTotal: 10, autoPost: true } }) });
  OPS.push({ area: `Voucher · ${k}`, name: "edit the narration", run: (w) => w.call(`/vouchers/${v(w, k)}`, { method: "PUT", body: { narration: "changed" } }) });
  OPS.push({ area: `Voucher · ${k}`, name: "edit the amounts", run: (w) => {
    const e = w.V[k].ledgerEntries;
    return w.call(`/vouchers/${v(w, k)}`, { method: "PUT", body: { ledgerEntries: e.map((x) => ({ ledgerId: String(x.ledgerId?._id || x.ledgerId), ledgerName: x.ledgerName, type: x.type, amount: x.amount + 1 })), grandTotal: e[0].amount + 1 } });
  } });
  OPS.push({ area: `Voucher · ${k}`, name: "move its date out to an open month", run: (w) => w.call(`/vouchers/${v(w, k)}`, { method: "PUT", body: { voucherDate: w.open } }) });
  OPS.push({ area: `Voucher · ${k}`, name: "cancel", run: (w) => w.call(`/vouchers/${v(w, k)}/cancel`, { method: "POST", body: { companyId: w.cid, reason: "test" } }) });
  OPS.push({ area: `Voucher · ${k}`, name: "void", run: (w) => w.call(`/vouchers/${v(w, k)}/void`, { method: "POST", body: { companyId: w.cid, reason: "test" } }) });
}
OPS.push({ area: "Voucher · any type", name: "move an open month's voucher INTO the period", setup: async (w) => {
  const r = await w.call("/vouchers", { method: "POST", body: { companyId: w.cid, voucherType: "journal", voucherDate: w.open, ledgerEntries: [{ ledgerId: w.id(w.L.rent), type: "Dr", amount: 20 }, { ledgerId: w.id(w.L.cash), type: "Cr", amount: 20 }], grandTotal: 20, autoPost: true } });
  w.june = r.body;
}, run: (w) => w.call(`/vouchers/${w.june._id}`, { method: "PUT", body: { voucherDate: w.date } }) });
OPS.push({ area: "Voucher · draft", name: "post a draft", run: (w) => w.call(`/vouchers/${v(w, "draft")}/post`, { method: "POST", body: {} }) });
OPS.push({ area: "Voucher · draft", name: "edit a draft", run: (w) => w.call(`/vouchers/${v(w, "draft")}`, { method: "PUT", body: { narration: "changed" } }) });
OPS.push({ area: "Voucher · draft", name: "delete a draft", run: (w) => w.call(`/vouchers/${v(w, "draft")}`, { method: "DELETE" }) });
OPS.push({ area: "Voucher · receipt", name: "match it to the sales invoice (bill-wise)", run: (w) => w.call(`/vouchers/${v(w, "receipt")}/match`, { method: "POST", body: { allocations: [{ billName: w.V.sales.voucherNumber, amount: 3000 }] } }) });
OPS.push({ area: "Voucher · receipt", name: "clear its bill matching", setup: async (w) => {
  await w.call(`/vouchers/${v(w, "receipt")}/match`, { method: "POST", body: { allocations: [{ billName: w.V.sales.voucherNumber, amount: 3000 }] } });
}, run: (w) => w.call(`/vouchers/${v(w, "receipt")}/match`, { method: "DELETE" }) });
OPS.push({ area: "Voucher · credit_note", name: "match it to the sales invoice", run: (w) => w.call(`/vouchers/${v(w, "credit_note")}/match`, { method: "POST", body: { allocations: [{ billName: w.V.sales.voucherNumber, amount: 1180 }] } }) });

/* sales invoices through the Invoices screens */
OPS.push({ area: "Sales invoice (Invoices page)", name: "edit", run: (w) => w.call(`/invoices/${v(w, "sales")}`, { method: "PUT", body: { companyId: w.cid, narration: "changed" } }) });
OPS.push({ area: "Sales invoice (Invoices page)", name: "cancel", run: (w) => w.call(`/invoices/${v(w, "sales")}/status`, { method: "PATCH", body: { status: "cancelled", reason: "test" } }) });
OPS.push({ area: "Sales invoice (Invoices page)", name: "void", run: (w) => w.call(`/invoices/${v(w, "sales")}/status`, { method: "PATCH", body: { status: "void", reason: "test" } }) });

/* journal entries (the Journal Entries page) */
const je = (w, posted) => String((posted ? w.jePosted : w.je)._id);
OPS.push({ area: "Journal entry", name: "create a new one dated in the period", run: (w) => w.call("/journal-entries", { method: "POST", body: { companyId: w.cid, entryDate: w.date, narration: "new", type: "adjusting", postImmediately: true, lines: [{ accountCode: w.id(w.L.rent), accountName: "Rent", debit: 50, credit: 0 }, { accountCode: w.id(w.L.cash), accountName: "Cash", debit: 0, credit: 50 }] } }) });
OPS.push({ area: "Journal entry", name: "edit a draft", run: (w) => w.call(`/journal-entries/${je(w)}`, { method: "PUT", body: { narration: "changed" } }) });
OPS.push({ area: "Journal entry", name: "post a draft", run: (w) => w.call(`/journal-entries/${je(w)}/post`, { method: "POST", body: {} }) });
OPS.push({ area: "Journal entry", name: "cancel a draft", run: (w) => w.call(`/journal-entries/${je(w)}/cancel`, { method: "POST", body: { reason: "test" } }) });
OPS.push({ area: "Journal entry", name: "delete a draft", run: (w) => w.call(`/journal-entries/${je(w)}`, { method: "DELETE" }) });
OPS.push({ area: "Journal entry", name: "void a posted one", run: (w) => w.call(`/journal-entries/${je(w, true)}/void`, { method: "POST", body: { reason: "test" } }) });

/* expenses */
OPS.push({ area: "Expense", name: "record a new one dated in the period", run: (w) => w.call("/expenses", { method: "POST", body: { companyId: w.cid, voucherDate: w.date, description: "Taxi", expenseLedgerId: w.id(w.L.rent), amount: 90, mode: "pay_now", bankLedgerId: w.id(w.L.bank), gstApplicable: false } }) });
OPS.push({ area: "Expense", name: "reject / unpost a posted one", run: (w) => w.call(`/expenses/${String(w.expense._id)}/reject`, { method: "POST", body: { reason: "test" } }) });

/* ledgers (Chart of Accounts) */
OPS.push({ area: "Ledger", name: "add a transaction from the ledger page, dated in the period", run: (w) => w.call(`/chart-of-accounts/ledgers/${w.id(w.L.rent)}/transactions`, { method: "POST", body: { companyId: w.cid, contraLedgerId: w.id(w.L.cash), type: "Dr", amount: 75, voucherDate: w.date, narration: "from ledger" } }) });
OPS.push({ area: "Ledger", name: "transfer its balance, dated in the period", run: (w) => w.call(`/chart-of-accounts/ledgers/${w.id(w.L.rent)}/transfer-balance`, { method: "POST", body: { companyId: w.cid, destinationLedgerId: w.id(w.L.rent2), voucherDate: w.date, narration: "transfer" } }) });
OPS.push({ area: "Ledger", name: "merge a ledger that has vouchers in the period", run: (w) => w.call(`/chart-of-accounts/ledgers/${w.id(w.L.rent)}/merge`, { method: "POST", body: { companyId: w.cid, destinationLedgerId: w.id(w.L.rent2) } }) });
OPS.push({ area: "Ledger", name: "merge ledgers (ghost-ledger merge)", run: (w) => w.call("/merge/ledgers", { method: "POST", body: { companyId: w.cid, survivorId: w.id(w.L.rent2), ghostIds: [w.id(w.L.rent)], confirm: "MERGE" } }) });
OPS.push({ area: "Ledger", name: "delete it, moving its vouchers to another ledger", run: (w) => w.call(`/chart-of-accounts/ledgers/${w.id(w.L.rent)}?alternativeLedgerId=${w.id(w.L.rent2)}&companyId=${w.cid}`, { method: "DELETE" }) });
/* allowed on a locked period — masters and harmless writes */
OPS.push({ area: "Ledger", name: "rename it (a master — stays open)", allowed: true, run: (w) => w.call(`/chart-of-accounts/ledgers/${w.id(w.L.rent)}`, { method: "PUT", body: { name: "Rent & Rates" } }) });
OPS.push({ area: "Ledger", name: "add a new ledger with no opening balance (a master — stays open)", allowed: true, run: (w) => w.call("/chart-of-accounts/ledgers", { method: "POST", body: { companyId: w.cid, name: "Electricity", groupId: String(w.L.rent.groupId), nature: "expense" } }) });
OPS.push({ area: "Sales invoice (Invoices page)", name: "log a payment reminder (not a figure — stays open)", allowed: true, run: (w) => w.call(`/invoices/${v(w, "sales")}/reminder`, { method: "POST", body: { channel: "phone", note: "called" } }) });
OPS.push({ area: "Voucher · receipt", name: "receive money in an OPEN month against the locked month's invoice (stays open)", allowed: true, setup: async (w) => {
  const r = await w.call("/vouchers", { method: "POST", body: { companyId: w.cid, voucherType: "receipt", voucherDate: w.open, partyLedgerId: w.id(w.L.customer), ledgerEntries: [{ ledgerId: w.id(w.L.bank), type: "Dr", amount: 1000 }, { ledgerId: w.id(w.L.customer), type: "Cr", amount: 1000 }], grandTotal: 1000, autoPost: true } });
  w.juneReceipt = r.body;
}, run: (w) => w.call(`/vouchers/${w.juneReceipt._id}/match`, { method: "POST", body: { allocations: [{ billName: w.V.sales.voucherNumber, amount: 1000 }] } }), mayChange: true });
OPS.push({ area: "Company settings", name: "save the company with the locks emptied (must NOT unlock)", allowed: true, run: (w) => w.call(`/tally/companies/${w.cid}`, { method: "PUT", body: { monthLocks: [], periodLocks: [], financialYearLocks: [], website: "https://example.com" } }), after: async (w) => {
  /* the lock must still hold after the company save */
  const r = await w.call(`/vouchers/${v(w, "journal")}`, { method: "PUT", body: { narration: "after the company save" } });
  return r.status === 423 ? "" : `the lock did not survive the company save (edit answered ${r.status})`;
} });

/* opening balances live on the books' first day — only an "up to" lock covers it */
const OPENING_OPS = [
  { area: "Ledger · opening balance", name: "change a ledger's opening balance", run: (w) => w.call(`/chart-of-accounts/ledgers/${w.id(w.L.rent)}`, { method: "PUT", body: { openingBalance: 999, openingBalanceType: "Dr" } }) },
  { area: "Ledger · opening balance", name: "add a new ledger WITH an opening balance", run: (w) => w.call("/chart-of-accounts/ledgers", { method: "POST", body: { companyId: w.cid, name: "Loan from director", groupId: String(w.L.vendor.groupId), nature: "liability", openingBalance: 50000, openingBalanceType: "Cr" } }) },
  { area: "Company settings", name: "move the books' first day", run: (w) => w.call(`/tally/companies/${w.cid}`, { method: "PUT", body: { booksFromDate: "2025-06-01T00:00:00.000Z" } }) },
];

async function attempt(op, lockKind, w) {
  const L = LOCKS[lockKind];
  if (op.setup) await op.setup(w);
  const locked = await L.lock(w);
  if (!ok(locked)) throw new Error(`lock ${lockKind}: ${locked.status} ${msgOf(locked)}`);
  forget();
  const before = await snapshot(w.cid);
  const r1 = await op.run(w);
  const after = await snapshot(w.cid);
  const extra = op.after ? await op.after(w) : "";
  const unlocked = await L.unlock(w);
  if (!ok(unlocked)) throw new Error(`unlock ${lockKind}: ${unlocked.status} ${msgOf(unlocked)}`);
  forget();
  const r2 = op.allowed ? null : await op.run(w);
  const row = {
    lock: lockKind,
    area: op.area,
    operation: op.name,
    expected: op.allowed ? "allowed while locked" : "refused while locked, allowed once unlocked",
    whileLocked: { status: r1.status, message: msgOf(r1).slice(0, 220), booksUnchanged: before === after },
    afterUnlock: r2 ? { status: r2.status, message: ok(r2) ? "" : msgOf(r2).slice(0, 220) } : null,
  };
  const problems = [];
  if (op.allowed) {
    if (!ok(r1)) problems.push(`refused while locked (${r1.status}: ${msgOf(r1)})`);
    if (extra) problems.push(extra);
  } else {
    if (r1.status !== 423) problems.push(`while locked answered ${r1.status} (${msgOf(r1)}), not 423`);
    if (before !== after) problems.push("the books changed while locked");
    if (!ok(r2)) problems.push(`after unlocking answered ${r2.status} (${msgOf(r2)})`);
  }
  row.verdict = problems.length ? `PROBLEM: ${problems.join("; ")}` : "as expected";
  REPORT.push(row);
  return problems;
}

describe("every edit path against a locked MONTH (May 2026)", () => {
  for (const op of OPS) {
    test(`${op.area} — ${op.name}`, async () => {
      const w = await world();
      expect(await attempt(op, "month", w)).toEqual([]);
    });
  }
});

describe("the same core edits against each kind of lock", () => {
  const CORE = OPS.filter((o) => o.area === "Voucher · journal" || o.area === "Voucher · draft" || o.name === "edit the amounts" && o.area === "Voucher · sales");
  for (const kind of ["year", "day", "week", "range", "upto"]) {
    for (const op of CORE) {
      test(`${kind} lock — ${op.area} — ${op.name}`, async () => {
        /* the year lock freezes FY 2025-26, so its books are dated in it */
        const w = await world(kind === "year" ? "2025-05-10T06:00:00.000Z" : MAY);
        expect(await attempt(op, kind, w)).toEqual([]);
      });
    }
  }
});

describe("opening balances against an 'everything up to' lock that covers the books' first day", () => {
  for (const op of OPENING_OPS) {
    test(`${op.area} — ${op.name}`, async () => {
      const w = await world();
      expect(await attempt(op, "upto", w)).toEqual([]);
    });
  }
});

test("the read the screens use lists every lock in force, and only those", async () => {
  const w = await world();
  await LOCKS.month.lock(w);
  await LOCKS.day.lock(w);
  forget();
  const r = await w.call(`/fy-locks/locked?companyId=${w.cid}`);
  expect(r.status).toBe(200);
  expect(r.body.locks.map((l) => [l.kind, l.label]).sort()).toEqual([["day", "10 May 2026"], ["month", "May 2026"]]);
  await LOCKS.day.unlock(w);
  forget();
  /* the month still covers the day the day-lock no longer does */
  const edit = await w.call(`/vouchers/${v(w, "journal")}`, { method: "PUT", body: { narration: "x" } });
  expect(edit.status).toBe(423);
  expect(msgOf(edit)).toMatch(/May 2026 is locked/);
});

test("a period lock: only days that are over, a reason, and the owner to unlock", async () => {
  const w = await world();
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const lock = (body) => w.call("/fy-locks/lock-period", { method: "POST", body: { companyId: w.cid, reason: "a proper reason here", ...body } });
  expect((await lock({ from: today, to: today })).status).toBe(400); // today is not over
  expect((await lock({ from: "2026-05-10", to: "2026-05-01" })).status).toBe(400); // backwards
  expect((await lock({ from: "2026-02-30", to: "2026-03-01" })).status).toBe(400); // not a date
  expect((await lock({ from: "2026-05-10", to: "2026-05-10", reason: "short" })).status).toBe(400);
  expect((await lock({ from: "2026-05-10", to: "2026-05-10" })).status).toBe(200);
  expect((await lock({ from: "2026-05-10", to: "2026-05-10" })).status).toBe(409);
  const list = await w.call(`/fy-locks?companyId=${w.cid}`);
  const onTheDay = await Acc_Voucher.countDocuments({ companyId: w.company._id, voucherDate: { $gte: new Date("2026-05-09T18:30:00Z"), $lte: new Date("2026-05-10T18:29:59.999Z") } });
  expect(onTheDay).toBeGreaterThan(8);
  expect(list.body.periods[0]).toMatchObject({ key: "2026-05-10..2026-05-10", label: "10 May 2026", locked: true, vouchers: onTheDay });
});
