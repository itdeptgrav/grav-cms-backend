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


/* ── ONE COMPANY, SO OWNERSHIP CAN BE PROVED (Chunk 3B1) ─────────────────────
 * Account, Lead and Contact creation now refuses unless the actor's company is
 * provable. These suites are not about tenancy, so they seed the simplest
 * thing that makes ownership provable: a single company, which is the
 * documented deployment fallback. Without it every creating test fails on a
 * refusal that is correct. */
beforeEach(async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  if (!(await Acc_Company.countDocuments({}))) {
    await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  }
});

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

  test("logging a message is still a first-class CRM activity — it just no longer moves the Lead", async () => {
    /* Calls, email and WhatsApp remain available and are still recorded. What
       changed is that they no longer drive the Lead's stage: that funnel was
       completed at the Prospect, and the Lead's own question is the
       requirement. */
    const lead = await createActiveLead();
    const logged = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "message", subject: "Pinged on WhatsApp", channel: "whatsapp", direction: "outbound", outcome: "no_answer" },
    });
    expect(logged.status).toBe(201);

    const after = await call(`/${lead._id}`);
    expect(after.body.lead.qualificationState).toBe("new");

    // and it buys no passage into the legacy states
    const refused = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(refused.status).toBe(400);
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
