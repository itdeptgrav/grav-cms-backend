// test/accountant/month-locks.route.test.js
//
// Locking a MONTH (15 Oct 2026, owner: "lock monthly wise, like the financial
// year"). A locked month is refused by the same guard as a frozen year: no
// voucher dated in it can be created, changed or deleted until an owner
// unlocks it, with a reason. Only a month that has ended can be locked, and
// not one inside a year that is already frozen.
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
  requireCompanyScope: (req, res, next) => next(),
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { forget } = require("../../services/accounting/fyLock");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Owner One", permissions: { canEdit: true, canApprove: true, canManageSettings: true }, isDev: true };
const APPROVER = { id: new mongoose.Types.ObjectId().toString(), name: "Approver Two", permissions: { canEdit: true, canApprove: true, canManageSettings: false }, isDev: true };
let server, root;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  app.use("/api/accountant/fy-locks", require("../../routes/Accountant_Routes/Acc_fyLocks"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  root = `http://127.0.0.1:${server.address().port}/api/accountant`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => forget());

async function call(path, { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function fixture() {
  const company = await Acc_Company.create({ companyName: "Month Lock Co", booksFromDate: new Date("2025-04-01") });
  const exp = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const bank = await Acc_Group.create({ companyId: company._id, name: "Bank Accounts", nature: "asset" });
  const rent = await Acc_Ledger.create({ companyId: company._id, name: "Rent", groupId: exp._id, groupName: exp.name, nature: "expense" });
  const sbi = await Acc_Ledger.create({ companyId: company._id, name: "SBI", groupId: bank._id, groupName: bank.name, nature: "asset" });
  const voucher = (date, amount = 1000) => ({
    companyId: company._id.toString(), voucherType: "payment", voucherDate: date,
    ledgerEntries: [
      { ledgerId: rent._id.toString(), ledgerName: "Rent", type: "Dr", amount },
      { ledgerId: sbi._id.toString(), ledgerName: "SBI", type: "Cr", amount },
    ],
    grandTotal: amount,
  });
  return { company, cid: company._id.toString(), voucher };
}

test("a locked month refuses its vouchers; the months beside it stay open; unlocking opens it again", async () => {
  const fx = await fixture();
  const may = await call("/vouchers", { method: "POST", body: fx.voucher("2026-05-10T00:00:00.000Z") });
  expect(may.status).toBe(201);

  const locked = await call("/fy-locks/lock-month", { method: "POST", body: { companyId: fx.cid, month: "2026-05", reason: "May books reconciled with bank" } });
  expect(locked.status).toBe(200);
  expect(locked.body.message).toMatch(/May 2026 is locked/);

  /* inside May: refused, with the month, who and why */
  const refused = await call("/vouchers", { method: "POST", body: fx.voucher("2026-05-20T00:00:00.000Z") });
  expect(refused.status).toBe(423);
  expect(JSON.stringify(refused.body)).toMatch(/May 2026 is locked by Owner One/);
  expect(JSON.stringify(refused.body)).toMatch(/May books reconciled with bank/);
  /* the last minute of 31 May in India is still May; 1 June is not */
  expect((await call("/vouchers", { method: "POST", body: fx.voucher("2026-05-31T18:29:00.000Z") })).status).toBe(423);
  expect((await call("/vouchers", { method: "POST", body: fx.voucher("2026-05-31T18:30:00.000Z") })).status).toBe(201);
  expect((await call("/vouchers", { method: "POST", body: fx.voucher("2026-04-30T00:00:00.000Z") })).status).toBe(201);

  /* the May voucher already there cannot be changed or moved out */
  const id = may.body._id;
  expect((await call(`/vouchers/${id}`, { method: "PUT", body: { narration: "edited" } })).status).toBe(423);
  expect((await call(`/vouchers/${id}`, { method: "PUT", body: { voucherDate: "2026-06-10T00:00:00.000Z" } })).status).toBe(423);

  /* the list shows May locked inside FY 2026-27, with its voucher count */
  const list = await call(`/fy-locks?companyId=${fx.cid}`);
  const fy = list.body.years.find((y) => y.fyStartYear === 2026);
  expect(fy.months).toHaveLength(12);
  expect(fy.months[0].month).toBe("2026-04");
  expect(fy.months[11].month).toBe("2027-03");
  const m = fy.months.find((x) => x.month === "2026-05");
  expect(m).toMatchObject({ label: "May 2026", locked: true, lockedByName: "Owner One", vouchers: 1, ended: true });
  expect(m.history).toHaveLength(1);

  /* an approver may lock but not unlock; the owner unlocks with a reason */
  expect((await call("/fy-locks/unlock-month", { method: "POST", user: APPROVER, body: { companyId: fx.cid, month: "2026-05", reason: "need to correct rent entry" } })).status).toBe(403);
  expect((await call("/fy-locks/unlock-month", { method: "POST", body: { companyId: fx.cid, month: "2026-05", reason: "need to correct rent entry" } })).status).toBe(200);
  expect((await call("/vouchers", { method: "POST", body: fx.voucher("2026-05-20T00:00:00.000Z") })).status).toBe(201);
  const after = (await call(`/fy-locks?companyId=${fx.cid}`)).body.years.find((y) => y.fyStartYear === 2026).months.find((x) => x.month === "2026-05");
  expect(after.locked).toBe(false);
  expect(after.history.map((h) => h.action)).toEqual(["unlock", "lock"]);
});

test("only an ended month, with a reason, outside a frozen year, can be locked", async () => {
  const fx = await fixture();
  const lock = (month, reason = "a proper reason here", user = OWNER) => call("/fy-locks/lock-month", { method: "POST", user, body: { companyId: fx.cid, month, reason } });
  const thisMonth = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
  expect((await lock(thisMonth)).status).toBe(400); // not ended
  expect((await lock("2026-05", "short")).status).toBe(400); // reason too short
  expect((await lock("2026-13")).status).toBe(400); // not a month
  /* only the owner locks (16 Oct 2026, owner: "that's only admin access") */
  expect((await lock("2026-05", "approver tries to lock a month", APPROVER)).status).toBe(403);
  expect((await lock("2026-05", "the owner locks the month")).status).toBe(200);
  expect((await lock("2026-05")).status).toBe(409); // already locked

  await Acc_Company.updateOne({ _id: fx.company._id }, { $push: { financialYearLocks: { fyStartYear: 2025, from: new Date("2025-03-31T18:30:00Z"), to: new Date("2026-03-31T18:29:59.999Z"), locked: true, lockReason: "FY closed" } } });
  forget(fx.cid);
  const inFrozen = await lock("2025-06");
  expect(inFrozen.status).toBe(409);
  expect(inFrozen.body.message).toMatch(/FY 2025-26, which is frozen/);
});
