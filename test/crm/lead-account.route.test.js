// test/crm/lead-account.route.test.js
//
// POST /api/cms/crm/leads/:id/account — the "Customer setup on the Active Lead"
// bridge. Creates a real Account for the lead (so contacts/locations/etc. can be
// set up before any Journey exists), idempotently, and links it via lead.accountId.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
jest.mock("../../services/changeLog", () => ({ recordChange: jest.fn().mockResolvedValue(undefined), historyForWithChildren: jest.fn() }));

const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SalesDepartment = require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/leads", require("../../routes/CMS_Routes/Sales/leads"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/leads`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(async () => {
  await _resetSequence(new Date().getFullYear());
  await DepartmentRole.deleteMany({});
  await SalesDepartment.deleteMany({});
  await SalesDepartment.create([{ _id: SALES_USER.id, email: SALES_USER.email, password: "x", name: SALES_USER.name, employeeId: "EMP-1", phone: "9000000001" }]);
});

async function call(path = "", { method = "GET", body, user = SALES_USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

// A lead that has moved past the draft/Prospect stage (Customer setup happens on
// an Active Lead). We don't run the whole review flow here — flip the status.
async function createActiveLead(fields = {}) {
  const { body } = await call("/", { method: "POST", body: { firstName: "Kiran", lastName: "Shah", company: "Buyer Co", ...fields } });
  await Lead.findByIdAndUpdate(body.lead._id, { captureStatus: "active" });
  return body.lead;
}

describe("POST /leads/:id/account", () => {
  test("creates a real Account seeded from the lead's company and links it", async () => {
    const lead = await createActiveLead({ company: "MAYFAIR Hotels" });
    const { status, body } = await call(`/${lead._id}/account`, { method: "POST" });
    expect(status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.account.companyName).toBe("MAYFAIR Hotels");
    const saved = await Lead.findById(lead._id).lean();
    expect(String(saved.accountId)).toBe(body.accountId);
  });

  test("is idempotent — a second call returns the SAME account, not a twin", async () => {
    const lead = await createActiveLead();
    const first = await call(`/${lead._id}/account`, { method: "POST" });
    const second = await call(`/${lead._id}/account`, { method: "POST" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.accountId).toBe(first.body.accountId);
    expect(await Account.countDocuments({})).toBe(1);
  });

  test("falls back to the person's name when there's no company", async () => {
    const { body } = await call("/", { method: "POST", body: { firstName: "Ravi", lastName: "Menon" } });
    await Lead.findByIdAndUpdate(body.lead._id, { captureStatus: "active" });
    const { status, body: res } = await call(`/${body.lead._id}/account`, { method: "POST" });
    expect(status).toBe(201);
    expect(res.account.companyName).toBe("Ravi Menon");
  });

  test("refuses on a draft Prospect", async () => {
    const { body } = await call("/", { method: "POST", body: { firstName: "Early", company: "Too Soon Co" } });
    await Lead.findByIdAndUpdate(body.lead._id, { captureStatus: "draft" });
    const { status } = await call(`/${body.lead._id}/account`, { method: "POST" });
    expect(status).toBe(400);
    expect(await Account.countDocuments({})).toBe(0);
  });
});
