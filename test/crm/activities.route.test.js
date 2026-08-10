// test/crm/activities.route.test.js
//
// HTTP-level tests for /api/cms/crm/activities (the ACCOUNT-scoped
// CRMActivity router). Added for Lead Chunk 1 review item 4: this router
// must not let a client inject a Lead owner or mutate system/audit fields,
// and ordinary Account-Activity create/update must keep working exactly as
// before (regression).
//
// Same harness pattern as the other Lead Chunk 1 route suites.
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

const Account = require("../../models/CMS_Models/Sales/Account");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const { createWithRef, _resetSequence } = require("../../services/leadRef");
const Lead = require("../../models/CMS_Models/Sales/Lead");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/activities", require("../../routes/CMS_Routes/Sales/activities"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/activities`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await _resetSequence(new Date().getFullYear());
});

async function call(path = "", { method = "GET", body, user = SALES_USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /activities — Account-scoped, whitelist hardening", () => {
  test("regression: an ordinary Account activity still creates normally", async () => {
    const acc = await Account.create({ companyName: "Regression Co" });
    const { status, body } = await call("/", {
      method: "POST",
      body: { accountId: acc._id.toString(), activityType: "note", subject: "Site visit notes" },
    });
    expect(status).toBe(201);
    expect(body.activity.accountId).toBe(acc._id.toString());
    expect(body.activity.subject).toBe("Site visit notes");
    expect(body.activity.leadId).toBeUndefined();
  });

  test("cannot inject a leadId into an Account-owned activity — the field is not in the whitelist at all", async () => {
    const acc = await Account.create({ companyName: "Injection Co" });
    const lead = await createWithRef(Lead, { firstName: "Someone" });
    const { status, body } = await call("/", {
      method: "POST",
      body: {
        accountId: acc._id.toString(),
        leadId: lead._id.toString(),
        activityType: "note",
        subject: "Attempted dual ownership",
      },
    });
    // `leadId` is absent from ACCOUNT_ACTIVITY_CREATE_FIELDS, so it is
    // silently dropped before Activity.create() ever sees it — the request
    // succeeds as an ordinary, Account-only activity, never as a
    // dual-owned one. (The model's XOR pre-validate hook is a second,
    // independent backstop — see the "BOTH accountId and leadId" test in
    // test/crm/lead.test.js, which reaches it directly.)
    expect(status).toBe(201);
    expect(body.activity.accountId).toBe(acc._id.toString());
    expect(body.activity.leadId).toBeUndefined();
    const stored = await Activity.findById(body.activity._id).lean();
    expect(stored.leadId).toBeUndefined();
  });

  test("cannot set activityId, isActive, archivedAt/archivedBy, or createdBy/updatedBy through the body", async () => {
    const acc = await Account.create({ companyName: "System Fields Co" });
    const fakeActor = { id: new mongoose.Types.ObjectId().toString(), name: "Not Really Anita" };
    const { status, body } = await call("/", {
      method: "POST",
      body: {
        accountId: acc._id.toString(),
        activityType: "note",
        subject: "System field injection attempt",
        activityId: "ACT-9999",
        isActive: false,
        archivedAt: new Date().toISOString(),
        archivedBy: fakeActor,
        createdBy: fakeActor,
        updatedBy: fakeActor,
      },
    });
    expect(status).toBe(201);
    expect(body.activity.activityId).not.toBe("ACT-9999");
    expect(body.activity.isActive).toBe(true);
    expect(body.activity.archivedAt).toBeFalsy();
    expect(body.activity.createdBy.name).toBe(SALES_USER.name);
    expect(body.activity.updatedBy.name).toBe(SALES_USER.name);
  });
});

describe("PATCH /activities/:id — Account-scoped, whitelist hardening", () => {
  test("regression: an ordinary field update still works", async () => {
    const acc = await Account.create({ companyName: "Update Regression Co" });
    const created = await call("/", {
      method: "POST",
      body: { accountId: acc._id.toString(), activityType: "note", subject: "Before" },
    });
    const { status, body } = await call(`/${created.body.activity._id}`, {
      method: "PATCH",
      body: { subject: "After" },
    });
    expect(status).toBe(200);
    expect(body.activity.subject).toBe("After");
  });

  test("cannot reassign an existing Account activity's accountId, or convert it to a Lead activity via update", async () => {
    const acc = await Account.create({ companyName: "Original Owner Co" });
    const otherAcc = await Account.create({ companyName: "Different Account Co" });
    const lead = await createWithRef(Lead, { firstName: "Someone" });
    const created = await call("/", {
      method: "POST",
      body: { accountId: acc._id.toString(), activityType: "note", subject: "Owned" },
    });

    const reassign = await call(`/${created.body.activity._id}`, {
      method: "PATCH",
      body: { accountId: otherAcc._id.toString() },
    });
    expect(reassign.status).toBe(200); // request succeeds — accountId is just silently not in the whitelist
    expect(reassign.body.activity.accountId).toBe(acc._id.toString()); // unchanged

    const toLead = await call(`/${created.body.activity._id}`, {
      method: "PATCH",
      body: { leadId: lead._id.toString() },
    });
    expect(toLead.status).toBe(200);
    expect(toLead.body.activity.leadId).toBeUndefined();
    expect(toLead.body.activity.accountId).toBe(acc._id.toString());
  });
});
