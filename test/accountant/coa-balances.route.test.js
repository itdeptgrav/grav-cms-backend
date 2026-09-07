// test/accountant/coa-balances.route.test.js
//
// A LEDGER'S BALANCE IS ITS POSTED VOUCHERS. NOTHING ELSE.
//
// ── THE FAULT THIS PINS DOWN ────────────────────────────────────────────────
// Every ledger record carries a stored `currentBalance`, kept up to date by
// `$inc` as vouchers post. It is a cache, and like every cache it can be wrong:
// an import writes it directly, a voucher is cancelled outside the increment
// path, a migration lands. Nothing ever reconciles it against the vouchers.
//
// The Chart of Accounts tree used to fall back to that cached figure whenever a
// ledger had no posted vouchers — on the reasoning that a stale number beat no
// number. On live books it meant NINE ledgers reported a balance with not one
// voucher behind them: PURCHASE at ₹1.55 crore, Bank Account at ₹29.9 lakh, and
// seven smaller. The page showed ₹1.28 crore that the trial balance, which
// reads vouchers, could not see — and the two screens disagreed about the same
// company with no way for a reader to tell which was lying.
//
// A ledger with no vouchers has no movement. Its balance is its opening balance
// and nothing else. That is what these tests hold to.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/chart-of-accounts",
    require("../../routes/Accountant_Routes/Acc_chartOfAccounts"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/chart-of-accounts`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const get = (path) =>
  fetch(`${base}${path}`, { headers: { "x-test-user": JSON.stringify(OWNER) } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/**
 * A company with one expense group and whatever ledgers a test asks for.
 * `stored` is the poisoned cache; `opening` is the real opening balance.
 */
async function seed(ledgerSpecs) {
  const company = await Acc_Company.create({
    companyName: `Test Co ${++seq}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id,
    name: `Purchase Accounts ${seq}`,
    nature: "expense",
    isActive: true,
  });
  const ledgers = {};
  for (const spec of ledgerSpecs) {
    ledgers[spec.key] = await Acc_Ledger.create({
      companyId: company._id,
      groupId: group._id,
      groupName: group.name,
      name: `${spec.key} ${seq}`,
      isActive: true,
      openingBalance: spec.opening || 0,
      openingBalanceType: spec.openingType || "Dr",
      currentBalance: spec.stored ?? 0,
      currentBalanceType: (spec.stored ?? 0) < 0 ? "Cr" : "Dr",
      nature: "expense",
    });
  }
  return { company, group, ledgers };
}

async function post(company, ledger, { dr = 0, cr = 0 }) {
  return Acc_Voucher.create({
    companyId: company._id,
    voucherType: "purchase",
    voucherNumber: `PU/${seq}/${Math.random().toString(36).slice(2, 8)}`,
    voucherDate: new Date("2026-06-15"),
    status: "posted",
    ledgerEntries: [
      { ledgerId: ledger._id, ledgerName: ledger.name, type: dr ? "Dr" : "Cr", amount: dr || cr },
    ],
    grandTotal: dr || cr,
  });
}

const tree = async (company) => (await get(`/tree?companyId=${company._id}`)).body;

/** Find a ledger anywhere in the returned tree. */
function findLedger(node, id) {
  for (const l of node.ledgers || []) if (String(l._id) === String(id)) return l;
  for (const c of node.children || []) {
    const hit = findLedger(c, id);
    if (hit) return hit;
  }
  return null;
}
function findAll(payload, id) {
  for (const root of payload.tree || payload.groups || []) {
    const hit = findLedger(root, id);
    if (hit) return hit;
  }
  return null;
}

/* ══ THE FAULT ═════════════════════════════════════════════════════════════ */

test("a cached balance with no vouchers behind it is not reported", async () => {
  // PURCHASE, exactly as it stands on the live books: ₹1,55,50,925 in the
  // cached field, no opening balance, and not one posted voucher.
  const { company, ledgers } = await seed([
    { key: "PURCHASE", stored: -15550924.8, opening: 0 },
  ]);
  const row = findAll(await tree(company), ledgers.PURCHASE._id);
  expect(row).toBeTruthy();
  expect(row.currentBalance).toBe(0);
});

test("the group total does not carry the phantom either", async () => {
  /* The per-ledger fix alone was not enough: the roll-up had its own fallback
     to `openingBalance` whenever a ledger computed to zero, which put the
     stale figure back one level up. */
  const { company, group, ledgers } = await seed([
    { key: "PURCHASE", stored: -15550924.8, opening: 0 },
    { key: "Real", stored: 0, opening: 0 },
  ]);
  await post(company, ledgers.Real, { dr: 40000 });

  const payload = await tree(company);
  const g = (payload.tree || payload.groups || []).find(
    (x) => String(x._id) === String(group._id),
  );
  expect(g).toBeTruthy();
  expect(g.rolledUpBalance).toBe(40000);
});

/* ══ WHAT MUST STILL WORK ══════════════════════════════════════════════════ */

test("vouchers drive the balance", async () => {
  const { company, ledgers } = await seed([{ key: "Freight", stored: 999999, opening: 0 }]);
  await post(company, ledgers.Freight, { dr: 25000 });
  await post(company, ledgers.Freight, { cr: 4000 });
  const row = findAll(await tree(company), ledgers.Freight._id);
  expect(row.currentBalance).toBe(21000);
});

test("an opening balance with no vouchers is the balance", async () => {
  // The legitimate case the old fallback existed to serve — and it still works,
  // because opening is added explicitly rather than substituted in.
  const { company, ledgers } = await seed([
    { key: "Carried", stored: 777777, opening: 60000, openingType: "Dr" },
  ]);
  const row = findAll(await tree(company), ledgers.Carried._id);
  expect(row.currentBalance).toBe(60000);
});

test("opening plus movement, not one or the other", async () => {
  const { company, ledgers } = await seed([
    { key: "Both", stored: -123456, opening: 10000, openingType: "Dr" },
  ]);
  await post(company, ledgers.Both, { dr: 5000 });
  const row = findAll(await tree(company), ledgers.Both._id);
  expect(row.currentBalance).toBe(15000);
});

test("a ledger that genuinely nets to zero reports zero", async () => {
  /* The case the roll-up's fallback got wrong: a real, computed zero was read
     as "no answer" and the opening balance was substituted back in. A zero is
     an answer. */
  const { company, ledgers } = await seed([
    { key: "NetsToZero", stored: 500000, opening: 0 },
  ]);
  await post(company, ledgers.NetsToZero, { dr: 8000 });
  await post(company, ledgers.NetsToZero, { cr: 8000 });
  const row = findAll(await tree(company), ledgers.NetsToZero._id);
  expect(row.currentBalance).toBe(0);
});

test("unposted vouchers are not money", async () => {
  const { company, ledgers } = await seed([{ key: "Draft", stored: 0, opening: 0 }]);
  await Acc_Voucher.create({
    companyId: company._id,
    voucherType: "purchase",
    voucherNumber: `PU/DRAFT/${seq}`,
    voucherDate: new Date("2026-06-15"),
    status: "draft",
    ledgerEntries: [
      { ledgerId: ledgers.Draft._id, ledgerName: ledgers.Draft.name, type: "Dr", amount: 90000 },
    ],
    grandTotal: 90000,
  });
  const row = findAll(await tree(company), ledgers.Draft._id);
  expect(row.currentBalance).toBe(0);
});

/* ══ THE TWO SCREENS MUST AGREE ════════════════════════════════════════════ */

test("/tree and /ledgers report the same figure for the same ledger", async () => {
  /* The whole point. These are two routes over one set of books, and a reader
     comparing them has no way to tell which is lying — so they must not be
     able to disagree. */
  const { company, ledgers } = await seed([
    { key: "Phantom", stored: -15550924.8, opening: 0 },
    { key: "Live", stored: 0, opening: 12000, openingType: "Dr" },
  ]);
  await post(company, ledgers.Live, { dr: 3000 });

  const treeBody = await tree(company);
  const list = (await get(`/ledgers?companyId=${company._id}`)).body;
  const rows = list.ledgers || list.data || [];

  for (const key of ["Phantom", "Live"]) {
    const id = ledgers[key]._id;
    const fromTree = findAll(treeBody, id);
    const fromList = rows.find((l) => String(l._id) === String(id));
    expect(fromList).toBeTruthy();
    expect(fromTree.currentBalance).toBe(fromList.currentBalance);
  }
});
