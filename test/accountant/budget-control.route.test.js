// test/accountant/budget-control.route.test.js
//
// Chunk 6 — budget control at the moment spend becomes POSTED.
//
// Two things are being proved here, and they are different:
//
//   1. The arithmetic. Does the check know what is allocated, what has
//      actually been spent, what THIS voucher adds, and what that leaves?
//   2. The coverage. Money becomes posted through FIVE different routes in
//      this app. A control wired into one of them is a control with four
//      holes, and holes in a spend gate are not a partial feature — they are
//      the route everyone eventually uses. Each gate is tested separately.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

/* The approvals router authenticates through a DIFFERENT middleware — it is
 * org-scoped rather than company-scoped. Mocked the same way so the executor
 * gates can be exercised over real HTTP rather than by calling the executor
 * directly, which would prove the function works and not that the route
 * reaches it. */
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: (perm) => (req, res, next) =>
    req.user?.permissions?.[perm] ? next() : res.status(403).json({ error: `Missing ${perm}` }),
}));

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

/* canPostDirectly matters: without it the voucher route diverts to the
 * approval workflow instead of posting, and the create gate never runs. */
const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};
const EDITOR = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Sam Editor",
  role: "editor",
  permissions: { canEdit: true },
};

let server;
let base;
let replSet;

beforeAll(async () => {
  /* Two of the five gates sit inside routes that open a MongoDB TRANSACTION
   * (/vouchers/:id/post and /approve). The shared test/setup.js starts a
   * STANDALONE in-memory mongod, where `startTransaction` fails outright — so
   * those routes cannot be exercised over HTTP against it at all.
   *
   * Rather than change the shared setup for every other suite, this file
   * swaps its own connection for a single-node replica set. The suite that
   * most needs to prove the gate fires is the one that would otherwise have
   * been quietly skipped. */
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "budget_control_test" });

  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  app.use("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  app.use("/api/accountant/expenses", require("../../routes/Accountant_Routes/Acc_expenses"));
  app.use("/api/accountant/approvals", require("../../routes/Accountant_Routes/Acc_approvals"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

async function call(path, { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let seq = 0;

async function seedCompany() {
  const company = await Acc_Company.create({ companyName: "Company A", booksFromDate: new Date("2026-04-01") });
  const revGroup = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const expGroup = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const bankGroup = await Acc_Group.create({ companyId: company._id, name: "Bank Accounts", nature: "asset" });
  const revenueLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Export Sales", groupId: revGroup._id, groupName: revGroup.name, nature: "revenue",
  });
  const expenseLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding", groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const bankLedger = await Acc_Ledger.create({
    companyId: company._id, name: "HDFC Current", groupId: bankGroup._id, groupName: bankGroup.name, nature: "asset",
  });
  return { company, revenueLedger, expenseLedger, bankLedger };
}

/** A live budget covering FY26-27 with one allocation on `ledger`. */
async function liveBudget({ companyId, ledger, allocated = 500000, department = "Logistics", nature = "expense", status = "active" }) {
  return Acc_Budget.create({
    name: "FY26-27",
    financialYear: "2026-27",
    period: "yearly",
    status,
    startDate: new Date("2026-04-01"),
    endDate: new Date("2027-03-31"),
    ...(companyId ? { companyId } : {}),
    items: [{ ledgerId: ledger._id, nature, department, allocatedAmount: allocated }],
  });
}

/** Spend already on the books. */
async function postedSpend({ companyId, ledger, amount, type = "Dr", status = "posted", isOptional = false }) {
  return Acc_Voucher.create({
    companyId,
    voucherType: "purchase",
    voucherNumber: `EX/${seq++}/${Date.now()}`,
    voucherDate: new Date("2026-06-01"),
    status,
    isOptional,
    grandTotal: amount,
    ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type, amount }],
  });
}

/** A balanced purchase voucher body: Dr the expense head, Cr the bank. */
function voucherBody({ companyId, expenseLedger, bankLedger, amount, extra = {} }) {
  return {
    companyId: String(companyId),
    voucherType: "purchase",
    voucherNumber: `PU/T${seq++}/${Date.now()}`,
    voucherDate: "2026-08-10",
    grandTotal: amount,
    ledgerEntries: [
      { ledgerId: String(expenseLedger._id), ledgerName: expenseLedger.name, type: "Dr", amount },
      { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Cr", amount },
    ],
    ...extra,
  };
}

const checkBody = ({ company, ledger, amount, type = "Dr", ...rest }) => ({
  companyId: String(company._id),
  voucherDate: "2026-08-10",
  ledgerEntries: [{ ledgerId: String(ledger._id), type, amount }],
  ...rest,
});

/* ── the availability check itself ────────────────────────────────────────── */

describe("check-availability", () => {
  test("ok when the allocation has room, with the projection spelled out", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 100000 });

    const { status, body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: expenseLedger, amount: 50000 }),
    });

    expect(status).toBe(200);
    expect(body.overallStatus).toBe("ok");
    expect(body.requiredOverride).toBe(false);

    const r = body.results[0];
    expect(r.allocated).toBe(500000);
    expect(r.actual).toBe(100000);
    expect(r.thisVoucher).toBe(50000);
    expect(r.projectedActual).toBe(150000);
    expect(r.remainingAfter).toBe(350000);
    expect(r.ledgerName).toBe("Freight & Forwarding");
  });

  test("over_budget when the projection exceeds the allocation, with the overage", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 480000 });

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: expenseLedger, amount: 50000 }),
    });

    expect(body.overallStatus).toBe("over_budget");
    expect(body.requiredOverride).toBe(true);
    expect(body.results[0].projectedActual).toBe(530000);
    expect(body.results[0].remainingAfter).toBe(-30000);
    expect(body.results[0].overBy).toBe(30000);
    expect(body.message).toMatch(/over budget by ₹30,000/);
  });

  test("warning_near_limit at the 90% line, and it does NOT demand an override", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 80000 });

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: expenseLedger, amount: 12000 }),
    });

    expect(body.overallStatus).toBe("warning_near_limit");
    expect(body.results[0].projectedPct).toBeCloseTo(92, 5);
    // Still inside the number — a warning, not a gate.
    expect(body.requiredOverride).toBe(false);
  });

  test("missing_budget when no live allocation covers the head", async () => {
    const { company, expenseLedger } = await seedCompany();

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: expenseLedger, amount: 5000 }),
    });

    expect(body.overallStatus).toBe("missing_budget");
    expect(body.requiredOverride).toBe(true);
    expect(body.results[0].allocated).toBe(0);
  });

  test("a draft or closed budget does not control spend; an EXCEEDED one still does", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000, status: "draft" });

    const notYet = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 1000 }),
    });
    expect(notYet.body.overallStatus).toBe("missing_budget");

    await Acc_Budget.updateMany({}, { $set: { status: "exceeded" } });
    // An already-blown budget is exactly the one that most needs checking —
    // dropping it would switch the control off when it starts to matter.
    const blown = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 1000 }),
    });
    expect(blown.body.overallStatus).toBe("ok");
    expect(blown.body.results[0].allocated).toBe(500000);
  });

  test("a budget whose period does not cover the voucher date is ignored", async () => {
    const { company, expenseLedger } = await seedCompany();
    const b = await liveBudget({ companyId: company._id, ledger: expenseLedger });
    await Acc_Budget.updateOne({ _id: b._id }, {
      $set: { startDate: new Date("2025-04-01"), endDate: new Date("2026-03-31") },
    });

    const { body } = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 1000 }),
    });
    expect(body.overallStatus).toBe("missing_budget");
  });

  /* ── scoping ──────────────────────────────────────────────────────────── */

  test("another company's budget and another company's spend are both invisible", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await liveBudget({ companyId: a.company._id, ledger: a.expenseLedger, allocated: 500000 });
    await liveBudget({ companyId: b.company._id, ledger: a.expenseLedger, allocated: 9999999 });

    await postedSpend({ companyId: a.company._id, ledger: a.expenseLedger, amount: 100000 });
    // B posts to the SAME head id — must not reach A's projection.
    await postedSpend({ companyId: b.company._id, ledger: a.expenseLedger, amount: 777777 });

    const { body } = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company: a.company, ledger: a.expenseLedger, amount: 1000 }),
    });
    expect(body.results[0].allocated).toBe(500000);
    expect(body.results[0].actual).toBe(100000);
  });

  test("no company context is reported as unscoped, not as a confident answer", async () => {
    const { expenseLedger } = await seedCompany();
    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: { voucherDate: "2026-08-10", ledgerEntries: [{ ledgerId: String(expenseLedger._id), type: "Dr", amount: 1000 }] },
    });
    expect(body.overallStatus).toBe("unscoped");
    expect(body.requiredOverride).toBe(false);
  });

  test("department narrows to that department's allocation", async () => {
    const { company, expenseLedger } = await seedCompany();
    await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), companyId: company._id,
      items: [
        { ledgerId: expenseLedger._id, nature: "expense", department: "Logistics", allocatedAmount: 400000 },
        { ledgerId: expenseLedger._id, nature: "expense", department: "Admin", allocatedAmount: 100000 },
      ],
    });

    const logistics = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 1000, department: "Logistics" }),
    });
    expect(logistics.body.results[0].allocated).toBe(400000);

    const admin = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 1000, department: "Admin" }),
    });
    expect(admin.body.results[0].allocated).toBe(100000);

    // No department named: the head's TOTAL approved allocation is the cap,
    // because that is genuinely what has been approved for the head.
    const neither = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 1000 }),
    });
    expect(neither.body.results[0].allocated).toBe(500000);
    expect(neither.body.results[0].budgets).toHaveLength(2);
  });

  /* ── what counts as actual ────────────────────────────────────────────── */

  test("draft, pending and optional vouchers are not spend", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 50000 });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 900000, status: "draft" });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 900000, status: "pending_approval" });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 900000, isOptional: true });

    const { body } = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 10000 }),
    });
    expect(body.results[0].actual).toBe(50000);
    expect(body.overallStatus).toBe("ok");
  });

  test("the proposed voucher IS included in the projection", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const under = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 99000 }),
    });
    expect(under.body.overallStatus).toBe("warning_near_limit");

    // Nothing is spent yet in either case; only the proposal differs.
    const over = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 101000 }),
    });
    expect(over.body.overallStatus).toBe("over_budget");
    expect(over.body.results[0].actual).toBe(0);
  });

  test("one voucher charging the same head twice is summed, not checked in halves", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    // Two 60k entries: each alone fits, together they do not. Checking them
    // separately against the same balance would clear both.
    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: {
        companyId: String(company._id),
        voucherDate: "2026-08-10",
        ledgerEntries: [
          { ledgerId: String(expenseLedger._id), type: "Dr", amount: 60000 },
          { ledgerId: String(expenseLedger._id), type: "Dr", amount: 60000 },
        ],
      },
    });
    expect(body.results).toHaveLength(1);
    expect(body.results[0].thisVoucher).toBe(120000);
    expect(body.overallStatus).toBe("over_budget");
  });

  test("a credit against an expense head reduces the proposed impact", async () => {
    const { company, expenseLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: {
        companyId: String(company._id),
        voucherDate: "2026-08-10",
        ledgerEntries: [
          { ledgerId: String(expenseLedger._id), type: "Dr", amount: 120000 },
          { ledgerId: String(expenseLedger._id), type: "Cr", amount: 40000 },
        ],
      },
    });
    expect(body.results[0].thisVoucher).toBe(80000);
    expect(body.overallStatus).toBe("ok");
  });

  /* ── revenue is a target, not a cap ───────────────────────────────────── */

  test("a revenue head is never a spend cap, even with no budget at all", async () => {
    const { company, revenueLedger } = await seedCompany();

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: revenueLedger, amount: 9000000, type: "Cr" }),
    });
    expect(body.overallStatus).toBe("ok");
    expect(body.requiredOverride).toBe(false);
    expect(body.results[0].nature).toBe("revenue");
    expect(body.results[0].note).toMatch(/targets, not spend limits/i);
  });

  test("beating a revenue target does not produce over_budget", async () => {
    const { company, revenueLedger } = await seedCompany();
    await liveBudget({
      companyId: company._id, ledger: revenueLedger, allocated: 1000000,
      nature: "revenue", department: "Sales",
    });
    await postedSpend({ companyId: company._id, ledger: revenueLedger, amount: 900000, type: "Cr" });

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: revenueLedger, amount: 900000, type: "Cr" }),
    });
    expect(body.overallStatus).toBe("ok");
    expect(body.requiredOverride).toBe(false);
  });

  test("a mixed voucher takes the worst status across its heads", async () => {
    const { company, expenseLedger, revenueLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 10000 });

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: {
        companyId: String(company._id),
        voucherDate: "2026-08-10",
        ledgerEntries: [
          { ledgerId: String(revenueLedger._id), type: "Cr", amount: 500000 },
          { ledgerId: String(expenseLedger._id), type: "Dr", amount: 500000 },
        ],
      },
    });
    expect(body.overallStatus).toBe("over_budget");
    expect(body.results).toHaveLength(2);
  });

  test("the FUNDING leg of a voucher is not treated as unbudgeted spend", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });

    // Nearly every real voucher has one: the bank it was paid from, the vendor
    // it is owed to. Those are assets and liabilities and no budget is ever
    // written against them. Defaulting an unresolved nature to "expense" made
    // the bank leg come back "no approved allocation" and refused an
    // ordinary payment — a control that blocks everything, which people would
    // rightly have switched off.
    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: {
        companyId: String(company._id),
        voucherDate: "2026-08-10",
        ledgerEntries: [
          { ledgerId: String(expenseLedger._id), type: "Dr", amount: 9000 },
          { ledgerId: String(bankLedger._id), type: "Cr", amount: 9000 },
        ],
      },
    });

    expect(body.overallStatus).toBe("ok");
    expect(body.requiredOverride).toBe(false);

    const bank = body.results.find((r) => r.ledgerName === "HDFC Current");
    expect(bank.status).toBe("ok");
    expect(bank.note).toMatch(/not budget-controlled/i);
    expect(bank.allocated).toBeNull();
  });

  test("a head whose nature cannot be resolved fails OPEN, not closed", async () => {
    const { company } = await seedCompany();
    // A ledger pointing at a group that no longer exists — the realistic
    // shape of mis-parented data, since the model requires a groupId but
    // nothing stops the group being deleted afterwards. natureByLedger then
    // resolves no nature at all. Refusing spend over it would punish the
    // wrong person; the budget screens still show the overspend afterwards.
    const orphan = await Acc_Ledger.create({
      companyId: company._id,
      name: "Orphaned Head",
      groupId: new mongoose.Types.ObjectId(),
      groupName: "Deleted Group",
      nature: "expense",
    });

    const { body } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: orphan, amount: 50000 }),
    });
    expect(body.overallStatus).toBe("ok");
    expect(body.requiredOverride).toBe(false);
    expect(body.results[0].note).toMatch(/no resolved nature/i);
  });

  test("a bad voucherDate is a clean 400", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { status } = await call("/budgets/check-availability", {
      method: "POST",
      body: checkBody({ company, ledger: expenseLedger, amount: 1000, voucherDate: "not-a-date" }),
    });
    expect(status).toBe(400);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * THE FIVE GATES
 * ────────────────────────────────────────────────────────────────────────── */

describe("gate 1 — voucher create with autoPost", () => {
  test("over budget without a reason is refused with 409 and the details", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const { status, body } = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 150000, extra: { autoPost: true } }),
    });

    expect(status).toBe(409);
    expect(body.code).toBe("BUDGET_OVERRIDE_REQUIRED");
    expect(body.budgetCheck.overallStatus).toBe("over_budget");
    expect(body.budgetCheck.results[0].overBy).toBe(50000);
    // Refused BEFORE the first save — nothing left behind to clean up.
    await expect(Acc_Voucher.countDocuments({ companyId: company._id })).resolves.toBe(0);
  });

  test("with a reason it posts, and the override is stamped on the voucher", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const { status, body } = await call("/vouchers", {
      method: "POST",
      body: voucherBody({
        companyId: company._id, expenseLedger, bankLedger, amount: 150000,
        extra: { autoPost: true, budgetOverrideReason: "Urgent shipment, CFO approved on call." },
      }),
    });

    expect(status).toBe(201);
    expect(body.status).toBe("posted");

    const saved = await Acc_Voucher.findById(body._id).lean();
    expect(saved.budgetOverride.required).toBe(true);
    expect(saved.budgetOverride.reason).toMatch(/CFO approved/);
    expect(saved.budgetOverride.status).toBe("over_budget");
    expect(saved.budgetOverride.overriddenByName).toBe("Priya Owner");
    expect(saved.budgetOverride.checkedAt).toBeInstanceOf(Date);
    // The snapshot keeps pointing at the numbers the approver actually saw.
    expect(saved.budgetOverride.results[0].allocated).toBe(100000);
    expect(saved.budgetOverride.results[0].projectedActual).toBe(150000);
    expect(saved.budgetOverride.results[0].remainingAfter).toBe(-50000);
  });

  test("within budget posts untouched, with no override metadata", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });

    const { status, body } = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 50000, extra: { autoPost: true } }),
    });

    expect(status).toBe(201);
    expect(body.status).toBe("posted");
    const saved = await Acc_Voucher.findById(body._id).lean();
    expect(saved.budgetOverride?.required).toBeUndefined();
  });

  test("a DRAFT is saved unchecked — drafting is not spending", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const { status, body } = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 999999 }),
    });
    expect(status).toBe(201);
    expect(body.status).toBe("draft");
  });

  test("a revenue voucher is never blocked by this", async () => {
    const { company, revenueLedger, bankLedger } = await seedCompany();
    const { status } = await call("/vouchers", {
      method: "POST",
      body: {
        companyId: String(company._id),
        voucherType: "sales",
        voucherNumber: `SL/T${seq++}/${Date.now()}`,
        voucherDate: "2026-08-10",
        grandTotal: 5000000,
        autoPost: true,
        ledgerEntries: [
          { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Dr", amount: 5000000 },
          { ledgerId: String(revenueLedger._id), ledgerName: revenueLedger.name, type: "Cr", amount: 5000000 },
        ],
      },
    });
    expect(status).toBe(201);
  });
});

describe("gate 2 — voucher /post", () => {
  async function draft({ company, expenseLedger, bankLedger, amount }) {
    const { body } = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount }),
    });
    return body;
  }

  test("posting a draft over budget is refused, and it stays a draft", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    const v = await draft({ company, expenseLedger, bankLedger, amount: 150000 });

    const { status, body } = await call(`/vouchers/${v._id}/post`, { method: "POST" });
    expect(status).toBe(409);
    expect(body.code).toBe("BUDGET_OVERRIDE_REQUIRED");

    const still = await Acc_Voucher.findById(v._id).lean();
    expect(still.status).toBe("draft");
  });

  test("posting with a reason succeeds and stamps the override", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    const v = await draft({ company, expenseLedger, bankLedger, amount: 150000 });

    const { status } = await call(`/vouchers/${v._id}/post`, {
      method: "POST",
      body: { budgetOverrideReason: "Board-approved capex overrun." },
    });
    expect(status).toBe(200);

    const saved = await Acc_Voucher.findById(v._id).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride.reason).toMatch(/Board-approved/);
  });

  test("posting within budget is unchanged", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });
    const v = await draft({ company, expenseLedger, bankLedger, amount: 50000 });

    const { status } = await call(`/vouchers/${v._id}/post`, { method: "POST" });
    expect(status).toBe(200);
    const saved = await Acc_Voucher.findById(v._id).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride?.required).toBeUndefined();
  });
});

describe("gate 3 — voucher /approve", () => {
  /** An editor's voucher lands in pending_approval rather than posting. */
  async function pending({ company, expenseLedger, bankLedger, amount }) {
    const { body } = await call("/vouchers", {
      method: "POST",
      user: EDITOR,
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount, extra: { autoPost: true } }),
    });
    return body;
  }

  test("an editor's over-budget voucher is not blocked at submit — it is blocked at approval", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    // Submitting is not spending; it goes to an approver.
    const v = await pending({ company, expenseLedger, bankLedger, amount: 150000 });
    expect(v.status).toBe("pending_approval");

    // Approving IS spending, and the approver answers for it.
    const refused = await call(`/vouchers/${v._id}/approve`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BUDGET_OVERRIDE_REQUIRED");
    await expect(
      Acc_Voucher.findById(v._id).then((d) => d.status),
    ).resolves.toBe("pending_approval");

    const ok = await call(`/vouchers/${v._id}/approve`, {
      method: "POST",
      body: { budgetOverrideReason: "Approved — freight surcharge outside our control." },
    });
    expect(ok.status).toBe(200);

    const saved = await Acc_Voucher.findById(v._id).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride.overriddenByName).toBe("Priya Owner");
    expect(saved.budgetOverride.reason).toMatch(/freight surcharge/);
  });
});

describe("gates 4 and 5 — the expense module", () => {
  const expenseBody = ({ company, expenseLedger, bankLedger, amount, extra = {} }) => ({
    companyId: String(company._id),
    voucherDate: "2026-08-10",
    description: "Courier for statutory filings",
    expenseLedgerId: String(expenseLedger._id),
    bankLedgerId: String(bankLedger._id),
    amount,
    mode: "pay_now",
    gstApplicable: false,
    ...extra,
  });

  test("gate 4 — an over-budget expense that posts immediately is refused, and nothing is written", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 50000 });

    const { status, body } = await call("/expenses", {
      method: "POST",
      body: expenseBody({ company, expenseLedger, bankLedger, amount: 90000 }),
    });

    expect(status).toBe(409);
    expect(body.code).toBe("BUDGET_OVERRIDE_REQUIRED");
    await expect(Acc_Voucher.countDocuments({ companyId: company._id })).resolves.toBe(0);
  });

  test("gate 4 — with a reason it posts and carries the override", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 50000 });

    const { status, body } = await call("/expenses", {
      method: "POST",
      body: expenseBody({
        company, expenseLedger, bankLedger, amount: 90000,
        extra: { budgetOverrideReason: "Statutory deadline; no alternative vendor." },
      }),
    });

    expect(status).toBe(201);
    const saved = await Acc_Voucher.findById(body.expense._id).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride.reason).toMatch(/Statutory deadline/);
    expect(saved.budgetOverride.status).toBe("over_budget");
  });

  test("gate 4 — an expense within budget is unaffected", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });

    const { status, body } = await call("/expenses", {
      method: "POST",
      body: expenseBody({ company, expenseLedger, bankLedger, amount: 9000 }),
    });
    expect(status).toBe(201);
    const saved = await Acc_Voucher.findById(body.expense._id).lean();
    expect(saved.budgetOverride?.required).toBeUndefined();
  });

  test("gate 5 — approving a drafted expense over budget is refused, then allowed with a reason", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 50000 });

    const created = await call("/expenses", {
      method: "POST",
      body: expenseBody({ company, expenseLedger, bankLedger, amount: 90000, extra: { autoPost: false } }),
    });
    expect(created.status).toBe(201);
    const id = created.body.expense._id;
    expect(created.body.expense.status).toBe("draft");

    const refused = await call(`/expenses/${id}/approve`, { method: "POST" });
    expect(refused.status).toBe(409);
    await expect(Acc_Voucher.findById(id).then((d) => d.status)).resolves.toBe("draft");

    const ok = await call(`/expenses/${id}/approve`, {
      method: "POST",
      body: { budgetOverrideReason: "Reviewed against Q2 accrual." },
    });
    expect(ok.status).toBe(200);
    const saved = await Acc_Voucher.findById(id).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride.reason).toMatch(/Q2 accrual/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * The control must agree with the screens
 * ────────────────────────────────────────────────────────────────────────── */

describe("the control and the budget screens agree", () => {
  test("what the check calls `actual` is what the budget detail calls `actual`", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });
    await postedSpend({ companyId: company._id, ledger: expenseLedger, amount: 210000 });

    const detail = await call(`/budgets/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);
    const check = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 0 }),
    });

    expect(check.body.results[0].actual).toBe(detail.body.budget.items[0].actual);
    expect(check.body.results[0].allocated).toBe(detail.body.budget.items[0].allocated);
  });

  test("a voucher posted through the gate shows up in the line drilldown", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    const budget = await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const created = await call("/vouchers", {
      method: "POST",
      body: voucherBody({
        companyId: company._id, expenseLedger, bankLedger, amount: 150000,
        extra: { autoPost: true, budgetOverrideReason: "Signed off." },
      }),
    });
    expect(created.status).toBe(201);

    const drill = await call(
      `/budgets/${budget._id}/items/${budget.items[0]._id}/vouchers?companyId=${company._id}`,
    );
    expect(drill.body.totals.actual).toBe(150000);
    expect(drill.body.vouchers).toHaveLength(1);
    expect(String(drill.body.vouchers[0].voucherId)).toBe(String(created.body._id));
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * CHUNK 6A — EDITS
 *
 * Chunk 6 gated every point at which a voucher BECOMES posted, which left one
 * way round the whole control: post ₹10,000 within budget, then edit the
 * posted voucher up to ₹10,00,000. The ledger moves either way.
 *
 * The trap unique to editing is self-counting: the voucher being edited is
 * ALREADY in the actuals, so a naive re-check reads it as its old amount plus
 * its new one and refuses edits that are perfectly fine. Several of these
 * tests exist only to pin that.
 * ────────────────────────────────────────────────────────────────────────── */
describe("gate 6 — editing a POSTED voucher", () => {
  /** A posted voucher for `amount`, created through the real gate. */
  async function posted({ company, expenseLedger, bankLedger, amount, reason }) {
    const { status, body } = await call("/vouchers", {
      method: "POST",
      body: voucherBody({
        companyId: company._id, expenseLedger, bankLedger, amount,
        extra: { autoPost: true, ...(reason ? { budgetOverrideReason: reason } : {}) },
      }),
    });
    expect(status).toBe(201);
    expect(body.status).toBe("posted");
    return body;
  }

  const editTo = (v, { expenseLedger, bankLedger, amount, extra = {} }) => ({
    method: "PUT",
    body: {
      voucherDate: v.voucherDate,
      grandTotal: amount,
      ledgerEntries: [
        { ledgerId: String(expenseLedger._id), ledgerName: expenseLedger.name, type: "Dr", amount },
        { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Cr", amount },
      ],
      ...extra,
    },
  });

  test("THE HOLE: editing a posted voucher upward past the allocation is now refused", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    // Posted well within budget — no override, nothing to answer for.
    const v = await posted({ company, expenseLedger, bankLedger, amount: 10000 });
    expect(v.budgetOverride?.required).toBeUndefined();

    // Now edit it to ten times the allocation. Before this chunk this saved.
    const { status, body } = await call(
      `/vouchers/${v._id}`,
      editTo(v, { expenseLedger, bankLedger, amount: 1000000 }),
    );

    expect(status).toBe(409);
    expect(body.code).toBe("BUDGET_OVERRIDE_REQUIRED");
    expect(body.budgetCheck.overallStatus).toBe("over_budget");

    // Refused BEFORE the reversal — the ledger is untouched and the voucher
    // still holds its original amount.
    const still = await Acc_Voucher.findById(v._id).lean();
    expect(still.status).toBe("posted");
    expect(still.grandTotal).toBe(10000);
    expect(still.ledgerEntries.find((e) => e.type === "Dr").amount).toBe(10000);
  });

  test("the voucher's OWN posted amount is excluded, so an in-budget edit is not self-blocked", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    // 60k posted. Editing to 90k is fine — but only if the check does NOT
    // count the existing 60k as history and add the new 90k on top, which
    // would read 150k and refuse.
    const v = await posted({ company, expenseLedger, bankLedger, amount: 60000 });
    const { status } = await call(
      `/vouchers/${v._id}`,
      editTo(v, { expenseLedger, bankLedger, amount: 90000 }),
    );
    expect(status).toBe(200);

    const saved = await Acc_Voucher.findById(v._id).lean();
    expect(saved.grandTotal).toBe(90000);
    expect(saved.budgetOverride?.required).toBeUndefined();

    // And the drilldown agrees: 90k total, not 150k.
    const check = await call("/budgets/check-availability", {
      method: "POST", body: checkBody({ company, ledger: expenseLedger, amount: 0 }),
    });
    expect(check.body.results[0].actual).toBe(90000);
  });

  test("editing DOWNWARD out of an overspend is allowed without a reason", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    const v = await posted({ company, expenseLedger, bankLedger, amount: 150000, reason: "Signed off." });

    // Fixing a mistake must not need a second signature.
    const { status } = await call(
      `/vouchers/${v._id}`,
      editTo(v, { expenseLedger, bankLedger, amount: 40000 }),
    );
    expect(status).toBe(200);
  });

  test("an over-budget edit WITH a reason saves and re-stamps the override with the new figures", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    const v = await posted({ company, expenseLedger, bankLedger, amount: 10000 });

    const { status } = await call(
      `/vouchers/${v._id}`,
      editTo(v, {
        expenseLedger, bankLedger, amount: 250000,
        extra: { budgetOverrideReason: "Scope grew — revised PO attached." },
      }),
    );
    expect(status).toBe(200);

    const saved = await Acc_Voucher.findById(v._id).lean();
    expect(saved.grandTotal).toBe(250000);
    expect(saved.budgetOverride.required).toBe(true);
    expect(saved.budgetOverride.reason).toMatch(/Scope grew/);
    // The snapshot is of THIS edit, not the original posting.
    expect(saved.budgetOverride.results[0].thisVoucher).toBe(250000);
    expect(saved.budgetOverride.results[0].actual).toBe(0);
    expect(saved.budgetOverride.results[0].remainingAfter).toBe(-150000);
  });

  test("moving a posted voucher's DATE out of the budget period is re-checked", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    // The budget only covers FY26-27.
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });
    const v = await posted({ company, expenseLedger, bankLedger, amount: 50000 });

    // Same amount, different year — now no live budget covers it at all.
    const { status, body } = await call(`/vouchers/${v._id}`, {
      method: "PUT",
      body: { voucherDate: "2029-08-10" },
    });
    expect(status).toBe(409);
    expect(body.budgetCheck.overallStatus).toBe("missing_budget");
  });

  test("editing a DRAFT is never blocked", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const created = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 10000 }),
    });
    expect(created.body.status).toBe("draft");

    const { status } = await call(
      `/vouchers/${created.body._id}`,
      editTo(created.body, { expenseLedger, bankLedger, amount: 9000000 }),
    );
    expect(status).toBe(200);
    // Still a draft, so still not money — the /post gate catches it later.
    const saved = await Acc_Voucher.findById(created.body._id).lean();
    expect(saved.status).toBe("draft");

    const refused = await call(`/vouchers/${created.body._id}/post`, { method: "POST" });
    expect(refused.status).toBe(409);
  });

  test("an edit that cannot move a budget skips the check entirely", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });
    // Deliberately ALREADY over budget: if this edit ran a check it would be
    // refused. It must not run one — a narration is not spend.
    const v = await posted({ company, expenseLedger, bankLedger, amount: 150000, reason: "Signed off." });

    const { status } = await call(`/vouchers/${v._id}`, {
      method: "PUT",
      body: { narration: "Corrected the description only." },
    });
    expect(status).toBe(200);

    const saved = await Acc_Voucher.findById(v._id).lean();
    expect(saved.narration).toBe("Corrected the description only.");
    expect(saved.grandTotal).toBe(150000);
    // The ORIGINAL override survives — the edit did not re-open the question.
    expect(saved.budgetOverride.reason).toBe("Signed off.");
  });

  test("a revenue voucher can be edited upward freely — a target is not a cap", async () => {
    const { company, revenueLedger, bankLedger } = await seedCompany();
    await liveBudget({
      companyId: company._id, ledger: revenueLedger, allocated: 1000000,
      nature: "revenue", department: "Sales",
    });

    const created = await call("/vouchers", {
      method: "POST",
      body: {
        companyId: String(company._id), voucherType: "sales",
        voucherNumber: `SL/E${seq++}/${Date.now()}`,
        voucherDate: "2026-08-10", grandTotal: 100000, autoPost: true,
        ledgerEntries: [
          { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Dr", amount: 100000 },
          { ledgerId: String(revenueLedger._id), ledgerName: revenueLedger.name, type: "Cr", amount: 100000 },
        ],
      },
    });
    expect(created.status).toBe(201);

    const { status } = await call(`/vouchers/${created.body._id}`, {
      method: "PUT",
      body: {
        grandTotal: 9000000,
        ledgerEntries: [
          { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Dr", amount: 9000000 },
          { ledgerId: String(revenueLedger._id), ledgerName: revenueLedger.name, type: "Cr", amount: 9000000 },
        ],
      },
    });
    expect(status).toBe(200);
  });

  test("another company's budget cannot be spent by editing into its head", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    // B has a huge allocation on the SAME head id; A has a small one.
    await liveBudget({ companyId: a.company._id, ledger: a.expenseLedger, allocated: 50000 });
    await liveBudget({ companyId: b.company._id, ledger: a.expenseLedger, allocated: 9999999 });

    const v = await posted({
      company: a.company, expenseLedger: a.expenseLedger, bankLedger: a.bankLedger, amount: 10000,
    });
    const { status, body } = await call(
      `/vouchers/${v._id}`,
      editTo(v, { expenseLedger: a.expenseLedger, bankLedger: a.bankLedger, amount: 500000 }),
    );
    expect(status).toBe(409);
    expect(body.budgetCheck.results[0].allocated).toBe(50000);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * The approvals engine posts money too — three more executors that Chunk 6
 * never saw, because they bypass the voucher routes entirely.
 * ────────────────────────────────────────────────────────────────────────── */
describe("gates 7–9 — the approvals executor", () => {
  const { Acc_ApprovalRequest } = require("../../models/Accountant_model/Acc_OrgModels");
  const ORG = new mongoose.Types.ObjectId().toString();

  const orgUser = (u) => ({ ...u, organizationId: ORG });
  const APPROVER = orgUser({ ...OWNER, role: "approver" });

  function request({ company, action, target, payload }) {
    return Acc_ApprovalRequest.create({
      organizationId: ORG,
      companyId: company._id,
      kind: "voucher",
      action,
      title: `${action} test`,
      ...(target ? { target: { collection: "Acc_Voucher", id: target } } : {}),
      ...(payload ? { payload } : {}),
      requestedBy: new mongoose.Types.ObjectId().toString(),
      requestedByName: "Sam Editor",
      status: "pending",
    });
  }

  const approve = (id, body) =>
    call(`/approvals/${id}/approve`, { method: "POST", body, user: APPROVER });

  test("gate 7 — approving a POST of an over-budget draft is refused, then allowed with a reason", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 50000 });

    const draft = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 200000 }),
    });
    const ar = await request({ company, action: "post", target: draft.body._id });

    const refused = await approve(ar._id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BUDGET_OVERRIDE_REQUIRED");
    await expect(
      Acc_Voucher.findById(draft.body._id).then((d) => d.status),
    ).resolves.toBe("draft");

    const ok = await approve(ar._id, { budgetOverrideReason: "Approved at board level." });
    expect(ok.status).toBe(200);
    const saved = await Acc_Voucher.findById(draft.body._id).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride.reason).toMatch(/board level/);
  });

  test("gate 8 — approving a CREATE that materialises a posted voucher is gated", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 50000 });

    const ar = await request({
      company,
      action: "create",
      payload: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 300000 }),
    });

    const refused = await approve(ar._id);
    expect(refused.status).toBe(409);
    await expect(Acc_Voucher.countDocuments({ companyId: company._id })).resolves.toBe(0);

    const ok = await approve(ar._id, { budgetOverrideReason: "Emergency repair, quoted twice." });
    expect(ok.status).toBe(200);
    const saved = await Acc_Voucher.findOne({ companyId: company._id }).lean();
    expect(saved.status).toBe("posted");
    expect(saved.budgetOverride.reason).toMatch(/Emergency repair/);
  });

  test("gate 9 — approving an UPDATE that pushes a posted voucher over budget is gated", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 100000 });

    const v = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 20000, extra: { autoPost: true } }),
    });
    expect(v.body.status).toBe("posted");

    const ar = await request({
      company, action: "update", target: v.body._id,
      payload: {
        grandTotal: 900000,
        ledgerEntries: [
          { ledgerId: String(expenseLedger._id), ledgerName: expenseLedger.name, type: "Dr", amount: 900000 },
          { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Cr", amount: 900000 },
        ],
      },
    });

    const refused = await approve(ar._id);
    expect(refused.status).toBe(409);
    // Untouched: not unposted, not re-valued.
    const still = await Acc_Voucher.findById(v.body._id).lean();
    expect(still.status).toBe("posted");
    expect(still.grandTotal).toBe(20000);

    const ok = await approve(ar._id, { budgetOverrideReason: "Variation order signed." });
    expect(ok.status).toBe(200);
    const saved = await Acc_Voucher.findById(v.body._id).lean();
    expect(saved.grandTotal).toBe(900000);
    expect(saved.budgetOverride.reason).toMatch(/Variation order/);
  });

  test("an approved update that stays within budget needs no reason", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    await liveBudget({ companyId: company._id, ledger: expenseLedger, allocated: 500000 });

    const v = await call("/vouchers", {
      method: "POST",
      body: voucherBody({ companyId: company._id, expenseLedger, bankLedger, amount: 20000, extra: { autoPost: true } }),
    });
    const ar = await request({
      company, action: "update", target: v.body._id,
      payload: {
        grandTotal: 60000,
        ledgerEntries: [
          { ledgerId: String(expenseLedger._id), ledgerName: expenseLedger.name, type: "Dr", amount: 60000 },
          { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Cr", amount: 60000 },
        ],
      },
    });

    const ok = await approve(ar._id);
    expect(ok.status).toBe(200);
    const saved = await Acc_Voucher.findById(v.body._id).lean();
    expect(saved.grandTotal).toBe(60000);
    expect(saved.budgetOverride?.required).toBeUndefined();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * CHUNK 8 — control must read the allocation a transfer left behind
 *
 * A transfer changes what two lines are worth. If budget control kept reading
 * the pre-transfer number, the destination would still be refused for spend it
 * now has budget for, and the source would still clear spend it no longer can
 * afford — which is the whole point of moving the money in the first place.
 * ────────────────────────────────────────────────────────────────────────── */
describe("budget control after a transfer", () => {
  test("the destination can spend what it was given, and the source can no longer spend what it gave", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    const expGroup = await Acc_Group.findOne({ companyId: company._id, nature: "expense" });
    const repairsLedger = await Acc_Ledger.create({
      companyId: company._id, name: "Repairs & Maintenance",
      groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
    });

    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        { ledgerId: repairsLedger._id, ledgerName: repairsLedger.name, nature: "expense", department: "Admin", allocatedAmount: 100000 },
        { ledgerId: expenseLedger._id, ledgerName: expenseLedger.name, nature: "expense", department: "Production", allocatedAmount: 50000 },
      ],
    });
    const q = `?companyId=${company._id}`;

    const spendCheck = (ledger, amount) =>
      call("/budgets/check-availability", {
        method: "POST",
        body: {
          companyId: String(company._id), voucherDate: "2026-08-10",
          ledgerEntries: [{ ledgerId: String(ledger._id), type: "Dr", amount }],
        },
      });

    // Before: Production cannot afford ₹90k; Admin can.
    expect((await spendCheck(expenseLedger, 90000)).body.overallStatus).toBe("over_budget");
    expect((await spendCheck(repairsLedger, 90000)).body.overallStatus).not.toBe("over_budget");

    const created = await call(`/budgets/${budget._id}/transfers${q}`, {
      method: "POST",
      body: {
        fromItemId: String(budget.items[0]._id),
        toItemId: String(budget.items[1]._id),
        amount: 60000,
        reason: "Admin repairs underspent; Production maintenance is short.",
      },
    });
    expect(created.status).toBe(201);
    const approved = await call(
      `/budgets/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`, { method: "POST" },
    );
    expect(approved.status).toBe(200);

    // After: exactly reversed. That is what the transfer was for.
    const prod = await spendCheck(expenseLedger, 90000);
    expect(prod.body.overallStatus).not.toBe("over_budget");
    expect(prod.body.results[0].allocated).toBe(110000);

    const admin = await spendCheck(repairsLedger, 90000);
    expect(admin.body.overallStatus).toBe("over_budget");
    expect(admin.body.results[0].allocated).toBe(40000);
    expect(admin.body.results[0].overBy).toBe(50000);
  });

  test("a voucher refused before a transfer posts cleanly after it", async () => {
    const { company, expenseLedger, bankLedger } = await seedCompany();
    const expGroup = await Acc_Group.findOne({ companyId: company._id, nature: "expense" });
    const repairsLedger = await Acc_Ledger.create({
      companyId: company._id, name: "Repairs & Maintenance",
      groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
    });
    const budget = await Acc_Budget.create({
      name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
      startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"),
      companyId: company._id,
      items: [
        { ledgerId: repairsLedger._id, ledgerName: repairsLedger.name, nature: "expense", department: "Admin", allocatedAmount: 100000 },
        { ledgerId: expenseLedger._id, ledgerName: expenseLedger.name, nature: "expense", department: "Production", allocatedAmount: 50000 },
      ],
    });
    const q = `?companyId=${company._id}`;

    const post = () =>
      call("/vouchers", {
        method: "POST",
        body: {
          companyId: String(company._id), voucherType: "purchase",
          voucherNumber: `TRC/${Date.now()}/${Math.round(Math.random() * 1e6)}`,
          voucherDate: "2026-08-10", grandTotal: 90000, autoPost: true,
          ledgerEntries: [
            { ledgerId: String(expenseLedger._id), ledgerName: expenseLedger.name, type: "Dr", amount: 90000 },
            { ledgerId: String(bankLedger._id), ledgerName: bankLedger.name, type: "Cr", amount: 90000 },
          ],
        },
      });

    const refused = await post();
    expect(refused.status).toBe(409);

    const created = await call(`/budgets/${budget._id}/transfers${q}`, {
      method: "POST",
      body: {
        fromItemId: String(budget.items[0]._id), toItemId: String(budget.items[1]._id),
        amount: 60000, reason: "Fund the maintenance run.",
      },
    });
    await call(`/budgets/${budget._id}/transfers/${created.body.transfer._id}/approve${q}`, { method: "POST" });

    // The legitimate path worked: no override reason was ever needed.
    const allowed = await post();
    expect(allowed.status).toBe(201);
    expect(allowed.body.status).toBe("posted");
    expect(allowed.body.budgetOverride?.required).toBeUndefined();
  });
});
