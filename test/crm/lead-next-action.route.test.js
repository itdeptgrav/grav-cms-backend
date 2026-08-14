// test/crm/lead-next-action.route.test.js
//
// Active Lead command centre — the single, deterministic NEXT ACTION.
// PATCH /:id/next-action keeps exactly one open planned follow-up (the earliest
// due = canonical, the same one the frontend picks), CANCELS older competing
// ones (history preserved, never deleted), keeps nextFollowUpAt synced, and — on
// a Lead-save failure — rolls the Activity writes back so the two never drift.
// A logged interaction is never lost if the optional next action fails.
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
const Activity = require("../../models/CMS_Models/Sales/Activity");
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
async function createActiveLead() {
  const { body } = await call("/", { method: "POST", body: { firstName: "Kiran", lastName: "Shah", company: "Buyer Co" } });
  return body.lead;
}
const mkFollowUp = (leadId, subject, dueDate) => Activity.create({
  leadId, activityType: "follow_up", subject, dueDate: new Date(dueDate), status: "planned",
  ownerId: SALES_USER.id, ownerName: SALES_USER.name,
});

const DUE = "2026-12-01T09:30:00.000Z";
const DUE2 = "2026-12-05T09:30:00.000Z";
const DUE3 = "2026-12-09T09:30:00.000Z";

describe("PATCH /:id/next-action — basics", () => {
  test("creates a planned follow-up and sets nextFollowUpAt when none is open", async () => {
    const lead = await createActiveLead();
    const res = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Send the quote", dueDate: DUE } });
    expect(res.status).toBe(200);
    expect(res.body.activity).toMatchObject({ activityType: "follow_up", subject: "Send the quote", status: "planned" });
    expect(new Date(res.body.lead.nextFollowUpAt).toISOString()).toBe(DUE);
    expect(await Activity.countDocuments({ leadId: lead._id, activityType: "follow_up", status: "planned" })).toBe(1);
  });

  test("updates the existing open follow-up in place (no pile-up)", async () => {
    const lead = await createActiveLead();
    const first = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Call procurement", dueDate: DUE } });
    const second = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Follow up on quote", dueDate: DUE2 } });
    expect(second.body.activity._id).toBe(first.body.activity._id);
    expect(second.body.activity.subject).toBe("Follow up on quote");
    expect(new Date(second.body.lead.nextFollowUpAt).toISOString()).toBe(DUE2);
    expect(await Activity.countDocuments({ leadId: lead._id, activityType: "follow_up", status: "planned" })).toBe(1);
  });

  test("rejects a Prospect (draft) and validates subject + due date", async () => {
    const draft = await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Drafty" } });
    const onDraft = await call(`/${draft.body.lead._id}/next-action`, { method: "PATCH", body: { subject: "x", dueDate: DUE } });
    expect(onDraft.status).toBe(400);
    expect(onDraft.body.message).toMatch(/prospect/i);

    const lead = await createActiveLead();
    expect((await call(`/${lead._id}/next-action`, { method: "PATCH", body: { dueDate: DUE } })).status).toBe(400);
    expect((await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "x" } })).status).toBe(400);
  });
});

describe("PATCH /:id/next-action — canonical + cancel older", () => {
  test("keeps the earliest-due follow-up as canonical, cancels the rest (history kept)", async () => {
    const lead = await createActiveLead();
    const f1 = await mkFollowUp(lead._id, "Earliest", DUE);   // earliest due → canonical
    const f2 = await mkFollowUp(lead._id, "Later", DUE2);      // competing → cancelled

    const res = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Do X", dueDate: DUE3 } });
    expect(res.status).toBe(200);
    expect(res.body.activity._id).toBe(String(f1._id)); // canonical updated in place

    const stillOpen = await Activity.find({ leadId: lead._id, activityType: "follow_up", status: "planned" });
    expect(stillOpen).toHaveLength(1);
    expect(String(stillOpen[0]._id)).toBe(String(f1._id));
    expect(stillOpen[0].subject).toBe("Do X");

    const cancelled = await Activity.findById(f2._id).lean();
    expect(cancelled.status).toBe("cancelled"); // not deleted — still there
    expect(await Activity.countDocuments({ leadId: lead._id, activityType: "follow_up" })).toBe(2); // history preserved

    const fresh = await Lead.findById(lead._id).lean();
    expect(new Date(fresh.nextFollowUpAt).toISOString()).toBe(DUE3);
  });
});

describe("PATCH /:id/next-action — consistency on failure", () => {
  test("a Lead-save failure rolls the Activity writes back (no drift)", async () => {
    const lead = await createActiveLead();
    await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Original action", dueDate: DUE } });
    const before = await Lead.findById(lead._id).lean();

    const spy = jest.spyOn(Lead.prototype, "save").mockImplementationOnce(() => Promise.reject(new Error("simulated lead-save failure")));
    const res = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "New action", dueDate: DUE2 } });
    spy.mockRestore();

    expect(res.status).toBe(400);
    // Lead untouched.
    const after = await Lead.findById(lead._id).lean();
    expect(new Date(after.nextFollowUpAt).toISOString()).toBe(new Date(before.nextFollowUpAt).toISOString());
    // Canonical Activity rolled back to its original subject/due; no extra created.
    const follows = await Activity.find({ leadId: lead._id, activityType: "follow_up" });
    expect(follows).toHaveLength(1);
    expect(follows[0].subject).toBe("Original action");
    expect(follows[0].status).toBe("planned");
    expect(new Date(follows[0].dueDate).toISOString()).toBe(DUE);
  });

  test("a logged interaction survives when the following next-action fails (no data loss)", async () => {
    const lead = await createActiveLead();
    const logged = await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Spoke to buyer", direction: "outbound", outcome: "replied_connected" } });
    expect(logged.status).toBe(201);

    const spy = jest.spyOn(Lead.prototype, "save").mockImplementationOnce(() => Promise.reject(new Error("simulated lead-save failure")));
    const na = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Send quote", dueDate: DUE } });
    spy.mockRestore();
    expect(na.status).toBe(400);

    // The interaction is still there; nothing about the failed next action removed it.
    const call1 = await Activity.findById(logged.body.activity._id).lean();
    expect(call1).toBeTruthy();
    expect(call1.subject).toBe("Spoke to buyer");
    // No stray next-action follow-up was left behind.
    expect(await Activity.countDocuments({ leadId: lead._id, activityType: "follow_up" })).toBe(0);
  });
});
