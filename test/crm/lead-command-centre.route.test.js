// test/crm/lead-command-centre.route.test.js
//
// HTTP-level tests for the Lead command-centre chunk's backend surface — the
// enriched interaction metadata now captured on a Lead-scoped CRMActivity:
//   • channel (WhatsApp / SMS / Other), direction (inbound / outbound) and
//     contactName persist and are validated against their vocabularies.
//   • the new "message" activity type is a real interaction: it persists,
//     counts as a logged OUTREACH ATTEMPT (enough for contactAttempted), and a
//     successful message outcome updates lastContactedAt — exactly like a call.
//
// Reuses lead-correction.route.test.js's harness shape (bare Express app,
// mocked SalesAuthMiddlewear + changeLog, real Mongoose).
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});

jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const Lead = require("../../models/CMS_Models/Sales/Lead");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SalesDepartment = require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/leads", require("../../routes/CMS_Routes/Sales/leads"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/leads`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await _resetSequence(new Date().getFullYear());
  await DepartmentRole.deleteMany({});
  await SalesDepartment.deleteMany({});
  await SalesDepartment.create([
    { _id: SALES_USER.id, email: SALES_USER.email, password: "x", name: SALES_USER.name, employeeId: "EMP-1", phone: "9000000001" },
  ]);
});

async function call(path = "", { method = "GET", body, user = SALES_USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

// createLead() with no captureStatus creates an ACTIVE Lead (drafts must ask
// for captureStatus:"draft"), so its Activity endpoints are open.
async function createActiveLead(over = {}) {
  const { body } = await call("/", { method: "POST", body: { firstName: "Kiran", lastName: "Shah", company: "Test Buyer Co", phone: "9800000000", ...over } });
  return body.lead;
}

describe("Lead command centre — enriched interaction logging", () => {
  test("a message interaction persists channel, direction and contactName", async () => {
    const lead = await createActiveLead();
    const res = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: {
        activityType: "message",
        subject: "WhatsApp intro",
        channel: "whatsapp",
        direction: "outbound",
        contactName: "Ravi Kumar",
        outcome: "replied_connected",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({
      activityType: "message",
      channel: "whatsapp",
      direction: "outbound",
      contactName: "Ravi Kumar",
      status: "completed",
    });
  });

  test("an out-of-vocabulary channel or direction is rejected", async () => {
    const lead = await createActiveLead();
    const badChannel = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "message", subject: "x", channel: "telegram" },
    });
    expect(badChannel.status).toBe(400);
    expect(badChannel.body.message).toMatch(/channel must be one of/i);

    const badDirection = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "call", subject: "x", direction: "sideways" },
    });
    expect(badDirection.status).toBe(400);
    expect(badDirection.body.message).toMatch(/direction must be one of/i);
  });

  test("a logged message counts as an outreach attempt (unblocks Contact Attempted)", async () => {
    const lead = await createActiveLead();
    const blocked = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(blocked.status).toBe(400);

    await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "message", subject: "Pinged on WhatsApp", channel: "whatsapp", direction: "outbound", outcome: "no_answer" },
    });
    const accepted = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(accepted.status).toBe(200);
  });

  test("a successful message outcome updates lastContactedAt", async () => {
    const lead = await createActiveLead();
    expect(lead.lastContactedAt).toBeFalsy();
    await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "message", subject: "Reached on WhatsApp", channel: "whatsapp", direction: "inbound", outcome: "replied_connected" },
    });
    const after = await Lead.findById(lead._id).lean();
    expect(after.lastContactedAt).toBeTruthy();
  });
});
