// test/crm/lead-clear-enum.route.test.js
//
// Prospect closeout: "Not sure yet" / "Unknown" must genuinely CLEAR a
// previously saved enum (Lead Source, Customer Segment). Sending "" through
// PATCH now $unsets the field (an empty string is not a valid enum value and
// never truly cleared it), so submission readiness flips back to unmet.
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

const checkMet = (checks, key) => (checks.find((c) => c.key === key) || {}).met;

describe("'Not sure yet' clears a saved Lead Source / Customer Segment", () => {
  test("PATCH source:'' and industry:'' unset the fields and flip readiness to unmet", async () => {
    const created = await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Kiran", company: "Test Buyer Co", source: "referral", industry: "hospitality" } });
    expect(created.status).toBe(201);
    const id = created.body.lead._id;
    expect(created.body.lead.source).toBe("referral");
    expect(created.body.lead.industry).toBe("hospitality");

    const before = await call(`/${id}/readiness`);
    expect(checkMet(before.body.checks, "source")).toBe(true);
    expect(checkMet(before.body.checks, "segment")).toBe(true);

    const patched = await call(`/${id}`, { method: "PATCH", body: { source: "", industry: "" } });
    expect(patched.status).toBe(200);

    // Genuinely unset on the persisted document, not stored as "".
    const stored = await Lead.findById(id).lean();
    expect(stored.source == null).toBe(true);
    expect(stored.industry == null).toBe(true);

    const after = await call(`/${id}/readiness`);
    expect(checkMet(after.body.checks, "source")).toBe(false);
    expect(checkMet(after.body.checks, "segment")).toBe(false);
  });

  test("clearing does not corrupt other saved fields", async () => {
    const created = await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Kiran", company: "Keeps Co", source: "google", industry: "retail_brand", city: "Bhubaneswar" } });
    const id = created.body.lead._id;
    await call(`/${id}`, { method: "PATCH", body: { source: "" } });
    const stored = await Lead.findById(id).lean();
    expect(stored.source == null).toBe(true);
    expect(stored.industry).toBe("retail_brand"); // untouched
    expect(stored.city).toBe("Bhubaneswar"); // untouched
  });
});
