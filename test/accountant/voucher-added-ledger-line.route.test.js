// test/accountant/voucher-added-ledger-line.route.test.js
//
// A purchase voucher can carry ledger lines the accountant added by hand
// ("Add another ledger line", 14 Oct 2026) to move an amount from one ledger to
// another. They are saved with `isAdjustment: true`, so the form can read them
// back as its own editable rows when the voucher is opened for editing; every
// line built from the bill keeps `isAdjustment: false`.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  ...jest.requireActual("../../Middlewear/AccountantOrgAuthMiddleware"),
  requireCompanyScope: (req, res, next) => next(),
  scopeCompanyIfPresent: (req, res, next) => next(),
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
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const EDITOR = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Editor",
  permissions: { canEdit: true, canApprove: true },
  isDev: true,
};
let server, base, root;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  app.use("/api/accountant/expenses", require("../../routes/Accountant_Routes/Acc_expenses"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/vouchers`;
  root = `http://127.0.0.1:${server.address().port}/api/accountant`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(EDITOR) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("lines added by hand are saved marked, balance with the bill, and come back marked", async () => {
  const company = await Acc_Company.create({ companyName: "Company A", booksFromDate: new Date("2025-04-01") });
  const purchaseGroup = await Acc_Group.create({ companyId: company._id, name: "Purchase Accounts", nature: "expense" });
  const expenseGroup = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const creditorGroup = await Acc_Group.create({ companyId: company._id, name: "Sundry Creditors", nature: "liability" });
  const purchase = await Acc_Ledger.create({ companyId: company._id, name: "Purchase — Interstate", groupId: purchaseGroup._id, groupName: purchaseGroup.name, nature: "expense" });
  const freight = await Acc_Ledger.create({ companyId: company._id, name: "Freight Inward", groupId: expenseGroup._id, groupName: expenseGroup.name, nature: "expense" });
  const vendor = await Acc_Ledger.create({ companyId: company._id, name: "VRL LOGISTICS LTD", groupId: creditorGroup._id, groupName: creditorGroup.name, nature: "liability" });

  const { status, body } = await call("/", {
    method: "POST",
    body: {
      companyId: company._id.toString(),
      voucherType: "purchase",
      voucherDate: "2026-04-01T00:00:00.000Z",
      partyLedgerId: vendor._id.toString(),
      ledgerEntries: [
        { ledgerId: purchase._id.toString(), ledgerName: purchase.name, type: "Dr", amount: 1000, signedAmount: 1000, narration: "Purchase — taxable value" },
        { ledgerId: vendor._id.toString(), ledgerName: vendor.name, type: "Cr", amount: 1000, signedAmount: -1000, isPartyLedger: true },
        /* move 250 of the purchase to freight: one debit line, one credit line */
        { ledgerId: freight._id.toString(), ledgerName: freight.name, type: "Dr", amount: 250, signedAmount: 250, narration: "Freight part of the bill", isAdjustment: true },
        { ledgerId: purchase._id.toString(), ledgerName: purchase.name, type: "Cr", amount: 250, signedAmount: -250, narration: "Adjustment", isAdjustment: true },
      ],
      grandTotal: 1000,
    },
  });
  expect(status).toBe(201);

  const stored = await Acc_Voucher.findById(body._id).lean();
  const added = stored.ledgerEntries.filter((e) => e.isAdjustment);
  expect(added.map((e) => [e.ledgerName, e.type, e.amount])).toEqual([
    ["Freight Inward", "Dr", 250],
    ["Purchase — Interstate", "Cr", 250],
  ]);
  expect(stored.ledgerEntries.filter((e) => !e.isAdjustment)).toHaveLength(2);
  expect(Acc_Voucher.balanceOf(stored.ledgerEntries).isBalanced).toBe(true);

  /* the edit form reads the voucher back through GET /:id */
  const read = await call(`/${body._id}`);
  expect(read.status).toBe(200);
  expect(read.body.ledgerEntries.filter((e) => e.isAdjustment)).toHaveLength(2);
});

async function post(path, body) {
  const res = await fetch(`${root}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(EDITOR) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function expenseFixture() {
  const company = await Acc_Company.create({ companyName: "Company E", booksFromDate: new Date("2025-04-01") });
  const exp = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const bank = await Acc_Group.create({ companyId: company._id, name: "Bank Accounts", nature: "asset" });
  const courier = await Acc_Ledger.create({ companyId: company._id, name: "Courier Charges", groupId: exp._id, groupName: exp.name, nature: "expense" });
  const freight = await Acc_Ledger.create({ companyId: company._id, name: "Freight Inward", groupId: exp._id, groupName: exp.name, nature: "expense" });
  const sbi = await Acc_Ledger.create({ companyId: company._id, name: "SBI Current", groupId: bank._id, groupName: bank.name, nature: "asset" });
  const body = (addedLines) => ({
    companyId: company._id.toString(), voucherDate: "2026-04-02T00:00:00.000Z", description: "Courier",
    expenseLedgerId: courier._id.toString(), amount: 500, mode: "pay_now", bankLedgerId: sbi._id.toString(),
    gstApplicable: false, autoPost: false, addedLines,
  });
  return { company, courier, freight, sbi, body };
}

test("an expense takes added ledger lines: saved marked, total unchanged, voucher balanced", async () => {
  const fx = await expenseFixture();
  const { status, body } = await post("/expenses", fx.body([
    { ledgerId: fx.freight._id.toString(), type: "Dr", amount: 120, narration: "Freight part" },
    { ledgerId: fx.courier._id.toString(), type: "Cr", amount: 120 },
  ]));
  expect(status).toBeLessThan(300);
  const v = await Acc_Voucher.findOne({ companyId: fx.company._id }).lean();
  expect(v.ledgerEntries.filter((e) => e.isAdjustment).map((e) => [e.ledgerName, e.type, e.amount, e.narration])).toEqual([
    ["Freight Inward", "Dr", 120, "Freight part"],
    ["Courier Charges", "Cr", 120, "Adjustment"],
  ]);
  expect(v.grandTotal).toBe(500);
  expect(Acc_Voucher.balanceOf(v.ledgerEntries).isBalanced).toBe(true);
});

test("an expense refuses added lines that do not balance, or name another company's ledger", async () => {
  const fx = await expenseFixture();
  const unbalanced = await post("/expenses", fx.body([{ ledgerId: fx.freight._id.toString(), type: "Dr", amount: 120 }]));
  expect(unbalanced.status).toBe(400);
  expect(unbalanced.body.error).toMatch(/do not balance/);
  const other = await expenseFixture();
  const foreign = await post("/expenses", fx.body([
    { ledgerId: other.freight._id.toString(), type: "Dr", amount: 50 },
    { ledgerId: fx.courier._id.toString(), type: "Cr", amount: 50 },
  ]));
  expect(foreign.status).toBe(400);
  expect(foreign.body.error).toMatch(/not found in this company/);
  await expect(Acc_Voucher.countDocuments({ companyId: fx.company._id })).resolves.toBe(0);
});
