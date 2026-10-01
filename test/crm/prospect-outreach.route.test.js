// test/crm/prospect-outreach.route.test.js
//
// A PROSPECT IS WORKED BEFORE IT IS QUALIFIED.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// A Prospect is the record a salesperson rings, mails and messages to discover
// whether interest exists. Every one of those acts was refused while the record
// was a Draft — "Prospects don't have Activities yet — start working the Lead
// first" — which left two options: work the customer and record nothing, or
// convert on hope to unlock the buttons. Both corrupt the funnel, and the
// second corrupts it in the direction that looks like progress.
//
// ── WHAT MUST NOT MOVE ──────────────────────────────────────────────────────
// Opening outreach is not opening qualification. A Prospect that logs a call is
// still a Prospect: `captureStatus` stays "draft", `qualificationState` is
// untouched, and the qualification-state route still refuses it. The tests
// below pin both halves — the new permission AND the boundary it must not
// cross — because a change that only proved the first would be indistinguishable
// from one that had quietly opened conversion too.
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
require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };
const OTHER_SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Deepak Nair", role: "sales", email: "deepak@example.com" };

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/leads", require("../../routes/CMS_Routes/Sales/leads"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/leads`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  await _resetSequence(new Date().getFullYear());
  await DepartmentRole.deleteMany({});
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  if (!(await Acc_Company.countDocuments({}))) {
    await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  }
});

async function call(path = "", { method = "GET", body, user = SALES_USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function createDraft(over = {}, user = SALES_USER) {
  const { body } = await call("/", {
    method: "POST",
    body: { captureStatus: "draft", company: "Zenith Apparel", ...over },
    user,
  });
  return body.lead;
}

const dueDate = "2026-09-15T09:00:00.000Z";

/* ══ THE PROSPECT CAN BE WORKED ════════════════════════════════════════════ */

test("a note can be written on a Prospect and read back", async () => {
  const lead = await createDraft();
  const made = await call(`/${lead._id}/activities`, {
    method: "POST",
    body: { activityType: "note", subject: "Asked for the winter catalogue" },
  });
  expect(made.status).toBe(201);

  const read = await call(`/${lead._id}/activities`);
  expect(read.status).toBe(200);
  expect(read.body.activities.map((a) => a.subject)).toContain("Asked for the winter catalogue");
});

test("calls, emails and messages are all loggable while it is still a Prospect", async () => {
  // The three channels a salesperson actually uses to find out whether there
  // is interest. Refusing any one of them is refusing the job.
  const lead = await createDraft();
  for (const [activityType, subject] of [
    ["call", "Rang the buyer"],
    ["email_log", "Sent the line sheet"],
    ["message", "WhatsApped the price list"],
  ]) {
    const r = await call(`/${lead._id}/activities`, { method: "POST", body: { activityType, subject } });
    expect([200, 201]).toContain(r.status);
  }
  const read = await call(`/${lead._id}/activities`);
  expect(read.body.activities).toHaveLength(3);
});

test("logging outreach does not convert the Prospect or move its qualification", async () => {
  /* The property that matters most. If this ever fails, the funnel is being
     advanced by the act of making a phone call. */
  const lead = await createDraft();
  const before = await Lead.findById(lead._id).lean();

  await call(`/${lead._id}/activities`, {
    method: "POST",
    body: { activityType: "call", subject: "First contact" },
  });

  const after = await Lead.findById(lead._id).lean();
  expect(after.captureStatus).toBe("draft");
  expect(after.qualificationState).toBe(before.qualificationState);
});

/* ══ THE NEXT ACTION ═══════════════════════════════════════════════════════ */

test("a Prospect can set and then update a next action", async () => {
  const lead = await createDraft();

  const set = await call(`/${lead._id}/next-action`, {
    method: "PATCH",
    body: { subject: "Call back Tuesday", dueDate },
  });
  expect(set.status).toBe(200);
  let doc = await Lead.findById(lead._id).lean();
  expect(doc.pendingFirstAction.subject).toBe("Call back Tuesday");
  expect(doc.nextFollowUpAt).toBeTruthy();

  const upd = await call(`/${lead._id}/next-action`, {
    method: "PATCH",
    body: { subject: "Send samples instead", dueDate },
  });
  expect(upd.status).toBe(200);
  doc = await Lead.findById(lead._id).lean();
  expect(doc.pendingFirstAction.subject).toBe("Send samples instead");
});

test("a Prospect's next action does not create a competing follow-up Activity", async () => {
  /* It is stored on `pendingFirstAction`, which approval turns into the Lead's
     first follow-up. Writing a live Activity here as well would leave approval
     creating a SECOND one from a field that was still set. */
  const lead = await createDraft();
  await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Call back", dueDate } });
  const followUps = await Activity.countDocuments({
    leadId: lead._id, activityType: "follow_up", status: "planned", isActive: true,
  });
  expect(followUps).toBe(0);
});

/* ══ ONE CONTINUOUS HISTORY ════════════════════════════════════════════════ */

test("outreach logged as a Prospect is still there after it becomes an Active Lead", async () => {
  /* Prospect and Lead are one record, so this should hold by construction —
     asserted because "by construction" is exactly the kind of claim that stops
     being true the day somebody adds a separate Prospect activity store. */
  const lead = await createDraft();
  await call(`/${lead._id}/activities`, {
    method: "POST",
    body: { activityType: "call", subject: "Introduced ourselves" },
  });

  await Lead.updateOne({ _id: lead._id }, { $set: { captureStatus: "active" } });

  const read = await call(`/${lead._id}/activities`);
  expect(read.status).toBe(200);
  expect(read.body.activities.map((a) => a.subject)).toContain("Introduced ourselves");
});

/* ══ THE BOUNDARY THAT MUST NOT MOVE ═══════════════════════════════════════ */

test("a Prospect still cannot move through Lead qualification states", async () => {
  const lead = await createDraft();
  const r = await call(`/${lead._id}/qualification-state`, {
    method: "PATCH",
    body: { qualificationState: "contactAttempted" },
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(String(r.body.message || "")).toMatch(/Prospect/i);

  const doc = await Lead.findById(lead._id).lean();
  expect(doc.captureStatus).toBe("draft");
});

test("logging outreach first does not unlock qualification", async () => {
  // The realistic attempt: satisfy the "contact attempted" evidence, then try
  // the transition anyway. The Draft guard runs before any evidence check.
  const lead = await createDraft();
  await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Rang them" } });
  const r = await call(`/${lead._id}/qualification-state`, {
    method: "PATCH",
    body: { qualificationState: "contactAttempted" },
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
});

/* ══ ACCESS ════════════════════════════════════════════════════════════════ */

test("another salesperson can neither read nor write a Prospect's activities", async () => {
  /* A Draft is private to its owner and the sales managers. Opening outreach
     must not have widened who can see it. */
  const lead = await createDraft();
  await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "note", subject: "Private note" } });

  const read = await call(`/${lead._id}/activities`, { user: OTHER_SALES_USER });
  expect(read.status).toBe(403);

  const write = await call(`/${lead._id}/activities`, {
    method: "POST",
    body: { activityType: "note", subject: "Not mine to add" },
    user: OTHER_SALES_USER,
  });
  expect(write.status).toBe(403);
});

test("an unauthenticated caller gets nothing", async () => {
  const lead = await createDraft();
  const r = await call(`/${lead._id}/activities`, { user: null });
  expect(r.status).toBe(401);
});

/* ══ THE LEGACY SINGULAR ROUTE ═════════════════════════════════════════════ */

test("the singular /activity route agrees with the canonical one", async () => {
  /* Requirement: no route may accept a Prospect activity while an equivalent
     supported route rejects it. They differed before this chunk. */
  const lead = await createDraft();
  /* Its own legacy body shape — {type, title, ...} — not the canonical
     {activityType, subject}. Sending the wrong one proves nothing about the
     Draft rule, which is what this test is for. */
  const r = await call(`/${lead._id}/activity`, {
    method: "POST",
    body: { type: "call", title: "Logged the old way", description: "Rang the buyer" },
  });
  expect(r.status).toBeLessThan(400);

  const read = await call(`/${lead._id}/activities`);
  expect(read.body.activities.map((a) => a.subject)).toContain("Logged the old way");
});

/* ══ AUTO-SYNC ON A PROSPECT ═══════════════════════════════════════════════
 * Auto-sync reads the evidence the phone and the webhook already captured —
 * calls placed, WhatsApp received — and logs it without anyone retyping it. It
 * used to return an empty result for a Draft, which switched it off precisely
 * where it is most useful: a Prospect is the record most likely to have real
 * call evidence and no typed activity at all.
 *
 * What must survive that change is the reason it is safe: it refuses to
 * attribute evidence whose number matches more than one record, and it never
 * logs the same call twice.
 * ═════════════════════════════════════════════════════════════════════════ */

const CallEvent = require("../../models/CallEvent");

/** A call the phone recorded, against this Prospect's number. */
async function recordCall(phone, over = {}) {
  return CallEvent.create({
    phoneNumber: phone,
    contactName: "Zenith Apparel",
    direction: "outgoing",
    received: true,
    startTime: new Date("2026-09-10T10:00:00.000Z"),
    durationSec: 95,
    ...over,
  });
}

test("a Prospect is no longer silently skipped by auto-sync", async () => {
  /* The old behaviour returned success with a zeroed result and logged
     nothing, which is indistinguishable from "there was nothing to find". */
  const lead = await createDraft({ phone: "9876500011" });
  await recordCall("9876500011");

  const r = await call(`/${lead._id}/activities/auto-sync`, { method: "POST" });
  expect(r.status).toBe(200);
  expect(r.body.logged).toBeDefined();
  expect(r.body.logged.calls).toBeGreaterThan(0);
});

test("the call it found becomes a real activity on the Prospect", async () => {
  const lead = await createDraft({ phone: "9876500022" });
  await recordCall("9876500022");
  await call(`/${lead._id}/activities/auto-sync`, { method: "POST" });

  const acts = await Activity.find({ leadId: lead._id, activityType: "call", isActive: true }).lean();
  expect(acts.length).toBe(1);
});

test("syncing again does not log the same call twice", async () => {
  /* The ten-minute window in the route. Without it, every open of the Prospect
     would add another copy of the same call. */
  const lead = await createDraft({ phone: "9876500033" });
  await recordCall("9876500033");

  await call(`/${lead._id}/activities/auto-sync`, { method: "POST" });
  const second = await call(`/${lead._id}/activities/auto-sync`, { method: "POST" });
  expect(second.status).toBe(200);
  expect(second.body.logged.calls).toBe(0);

  const acts = await Activity.countDocuments({ leadId: lead._id, activityType: "call", isActive: true });
  expect(acts).toBe(1);
});

test("evidence whose number matches two Prospects is not attributed to either", async () => {
  /* The protection that makes auto-sync safe to switch on. Two records share a
     number; a call to it belongs to nobody in particular, so it is counted as
     skipped rather than guessed at. */
  const shared = "9876500044";
  const a = await createDraft({ phone: shared, company: "Alpha Apparel" });
  await createDraft({ phone: shared, company: "Beta Apparel" });
  await recordCall(shared);

  const r = await call(`/${a._id}/activities/auto-sync`, { method: "POST" });
  expect(r.status).toBe(200);
  expect(r.body.skippedAmbiguous.phone).toBe(true);
  expect(r.body.logged.calls).toBe(0);

  const acts = await Activity.countDocuments({ leadId: a._id, activityType: "call", isActive: true });
  expect(acts).toBe(0);
});

test("auto-sync leaves the Prospect a Prospect", async () => {
  /* Importing evidence is not progress through the funnel. If this ever fails,
     a customer answering the phone has advanced their own qualification. */
  const lead = await createDraft({ phone: "9876500055" });
  await recordCall("9876500055");
  const before = await Lead.findById(lead._id).lean();

  await call(`/${lead._id}/activities/auto-sync`, { method: "POST" });

  const after = await Lead.findById(lead._id).lean();
  expect(after.captureStatus).toBe("draft");
  expect(after.qualificationState).toBe(before.qualificationState);
});
