// test/crm/prospect-work-state.route.test.js
//
// WHERE A PROSPECT HAS GOT TO, DERIVED FROM WHAT WAS ACTUALLY DONE.
//
// ── WHAT THIS IS GUARDING AGAINST ───────────────────────────────────────────
// The easy version of this feature is a status field somebody drags between
// columns. It is accurate for about a week: statuses get moved when a person
// remembers rather than when work happens, and the board then reports a
// pipeline that does not exist. It can also be advanced without doing
// anything, which makes the appearance of progress the cheapest thing on the
// screen to manufacture.
//
// So the state is a function of the record and its activity. These tests pin
// the four states, their precedence, and — just as important — the two things
// that must NOT advance one: a note, and a follow-up somebody merely planned.
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
const work = require("../../services/prospectWorkState");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };
let server, base;
const dueDate = "2026-09-15T09:00:00.000Z";

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

async function draft(over = {}) {
  const { body } = await call("/", {
    method: "POST",
    body: { captureStatus: "draft", company: "Zenith Apparel", ...over },
  });
  return body.lead;
}

/** A completed call that the customer actually answered. */
const act = (leadId, over = {}) =>
  Activity.create({
    leadId, activityType: "call", subject: "Rang them",
    status: "completed", completedAt: new Date(), outcome: "replied_connected",
    ownerId: SALES_USER.id, ...over,
  });

/** The state the DETAIL endpoint reports. */
const workStateOf = async (id) => (await call(`/${id}`)).body.lead.workState;
const stateOf = async (id) => (await workStateOf(id))?.code;

/* ══ THE FOUR STATES ═══════════════════════════════════════════════════════ */

test("a Prospect nobody has tried to reach is New", async () => {
  const lead = await draft();
  expect(await stateOf(lead._id)).toBe(work.STATES.NEW);
});

test("an attempt that did not connect is Contacting", async () => {
  /* CORRECTED: an attempt is a COMPLETED call that did not get through, not a
     planned one. A planned call is scheduled work and says nothing about the
     customer — the original version of this test encoded that mistake. */
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "No answer",
    status: "completed", completedAt: new Date(), outcome: "no_answer",
    ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.CONTACTING);
});

test("a completed interaction is Follow-up", async () => {
  const lead = await draft();
  await act(lead._id);
  expect(await stateOf(lead._id)).toBe(work.STATES.FOLLOW_UP);
});

test("a Prospect the form can convert is Ready to convert", async () => {
  const lead = await draft({ phone: "9876500011" });
  await Lead.updateOne({ _id: lead._id }, { $set: {
    prospectType: "company", source: "referral",
    pendingFirstAction: { subject: "Send the catalogue", dueDate: new Date(dueDate) },
  } });
  await act(lead._id);
  expect(await stateOf(lead._id)).toBe(work.STATES.READY);
});

/* ══ PRECEDENCE ════════════════════════════════════════════════════════════ */

test("Ready wins over Follow-up, which wins over Contacting", async () => {
  /* A ready Prospect also has completed calls and outreach attempts. Without a
     precedence rule it would answer to three states at once, and which one it
     reported would depend on the order the conditions happened to be written. */
  const lead = await draft({ phone: "9876500022" });
  await Activity.create({
    leadId: lead._id, activityType: "message", subject: "Messaged, no reply",
    status: "completed", completedAt: new Date(), ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.CONTACTING);

  await act(lead._id); // now somebody got through
  expect(await stateOf(lead._id)).toBe(work.STATES.FOLLOW_UP);

  await Lead.updateOne({ _id: lead._id }, { $set: {
    prospectType: "company", source: "referral",
    pendingFirstAction: { subject: "Send it", dueDate: new Date(dueDate) },
  } });
  expect(await stateOf(lead._id)).toBe(work.STATES.READY);
});

/* ══ WHAT MUST NOT ADVANCE IT ══════════════════════════════════════════════ */

test("a note is not contact", async () => {
  /* Otherwise the queue advances by typing. Writing "they seem keen" to
     yourself is not reaching a customer. */
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "note", subject: "They seem keen",
    status: "completed", completedAt: new Date(), ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.NEW);
});

test("a planned follow-up alone is not a completed interaction", async () => {
  /* An intention to ring somebody is not evidence that anybody rang them. */
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "follow_up", subject: "Call Tuesday",
    status: "planned", dueDate: new Date(dueDate), ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.NEW);
});

test("a call planned for 4pm has not happened, so it advances nothing", async () => {
  /* CORRECTED. This asserted that a planned call reached Contacting, which
     made the queue advanceable by scheduling — the cheapest possible way to
     look busy. */
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Will ring at 4",
    status: "planned", ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.NEW);
});

/* ══ ONE QUERY, AND ONE ANSWER ═════════════════════════════════════════════ */

test("the list derives every card's state without a query per card", async () => {
  /* Forty Prospects asking "has anybody rung this one" forty times is forty
     round trips to draw one screen, and it degrades exactly as the team gets
     busier. */
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const l = await draft({ company: `Co ${i}`, phone: `98765001${i}${i}` });
    ids.push(l._id);
    if (i % 2 === 0) await act(l._id);
  }

  const spy = jest.spyOn(Activity, "aggregate");
  const r = await call("/?captureStatus=draft&limit=50");
  expect(r.status).toBe(200);

  const drafts = r.body.leads.filter((l) => l.captureStatus === "draft");
  expect(drafts.length).toBeGreaterThanOrEqual(6);
  for (const l of drafts) expect(l.workState?.code).toBeTruthy();

  /* One aggregate for the whole page, whatever its size. */
  expect(spy.mock.calls.length).toBe(1);
  spy.mockRestore();
});

test("the list and the detail page report the same state", async () => {
  /* Two derivations of one idea is two answers, and the believed one is
     whichever screen was looked at last. */
  const lead = await draft({ phone: "9876500033" });
  await act(lead._id);

  const list = await call("/?captureStatus=draft&limit=50");
  const fromList = list.body.leads.find((l) => String(l._id) === String(lead._id));
  const fromDetail = (await call(`/${lead._id}`)).body.lead;

  expect(fromList.workState.code).toBe(fromDetail.workState.code);
  expect(fromList.workState.label).toBe(fromDetail.workState.label);
});

test("each state carries the label and the one action its card should offer", async () => {
  const lead = await draft();
  const ws = (await call(`/${lead._id}`)).body.lead.workState;
  expect(ws.label).toBe("New");
  expect(ws.actionLabel).toBe("Start outreach");
});

/* ══ NOTHING STORED, NOTHING ELSE MOVED ════════════════════════════════════ */

test("no second status is written to the Lead", async () => {
  /* The state is derived. A stored copy would be one more thing to keep in
     step, and the day it drifted the queue would be confidently wrong. */
  const lead = await draft();
  await act(lead._id);
  await call(`/${lead._id}`);
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.workState).toBeUndefined();
  expect(doc.prospectStatus).toBeUndefined();
  expect(doc.captureStatus).toBe("draft");
});

test("captureStatus, reviewStatus and qualificationState are untouched by it", async () => {
  const lead = await draft();
  const before = await Lead.findById(lead._id).lean();
  await act(lead._id);
  await call(`/${lead._id}`);
  const after = await Lead.findById(lead._id).lean();
  expect(after.captureStatus).toBe(before.captureStatus);
  expect(after.reviewStatus).toBe(before.reviewStatus);
  expect(after.qualificationState).toBe(before.qualificationState);
});

/* ══ THE LEGACY REVIEW FLOW IS NOT STRANDED ════════════════════════════════ */

test("a legacy submitted Prospect is still listed and still reachable", async () => {
  /* The old HOD flow has real records in it. Replacing the normal workflow
     must not orphan them. */
  const lead = await draft({ phone: "9876500044" });
  await Lead.updateOne({ _id: lead._id }, { $set: { reviewStatus: "submitted" } });

  const detail = await call(`/${lead._id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.lead.reviewStatus).toBe("submitted");
  // and it still gets a derived state like any other Prospect
  expect(detail.body.lead.workState?.code).toBeTruthy();

  const list = await call("/?captureStatus=draft&limit=50");
  expect(list.body.leads.some((l) => String(l._id) === String(lead._id))).toBe(true);
});

test("an Active Lead gets no Prospect work state", async () => {
  // It has stages of its own; this concept does not apply.
  const lead = await draft();
  await Lead.updateOne({ _id: lead._id }, { $set: { captureStatus: "active" } });
  const r = await call(`/${lead._id}`);
  expect(r.body.lead.workState).toBeUndefined();
});


/* ══ AN ATTEMPT IS NOT A CONVERSATION ══════════════════════════════════════
 * The first implementation treated any COMPLETED outreach as a successful
 * interaction. A call that rang out is completed — so a Prospect nobody had
 * ever spoken to reached Follow-up and could satisfy conversion readiness on a
 * string of unanswered calls.
 *
 * The CRM already drew this line: `OUTREACH_ATTEMPT_ACTIVITY_TYPES` for "we
 * tried", `SUCCESSFUL_CONTACT_OUTCOMES` for "they engaged". These pin it.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a call planned for later moves nothing — it is scheduled work", async () => {
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Ring them Friday",
    status: "planned", dueDate: new Date(dueDate), ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.NEW);
});

test("a completed call nobody answered is Contacting, never Follow-up", async () => {
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "No answer",
    status: "completed", completedAt: new Date(), outcome: "no_answer",
    ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.CONTACTING);
});

test("an email sent with no reply is Contacting", async () => {
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "email_log", subject: "Sent the line sheet",
    status: "completed", completedAt: new Date(), ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.CONTACTING);
});

test("a reply, or a connected call, is Follow-up", async () => {
  const lead = await draft();
  await act(lead._id); // outcome: replied_connected
  expect(await stateOf(lead._id)).toBe(work.STATES.FOLLOW_UP);
});

test("a completed meeting is Follow-up", async () => {
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "meeting", subject: "Met at their office",
    status: "completed", completedAt: new Date(), outcome: "meeting_completed",
    ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.FOLLOW_UP);
});

test("a site visit counts as an attempt — the canonical vocabulary includes it", async () => {
  const lead = await draft();
  await Activity.create({
    leadId: lead._id, activityType: "site_visit", subject: "Dropped in",
    status: "completed", completedAt: new Date(), ownerId: SALES_USER.id,
  });
  expect(await stateOf(lead._id)).toBe(work.STATES.CONTACTING);
});

test("unanswered calls are Contacting, and cannot clear the conversion bar", async () => {
  /* Both halves of the ladder read the same fact, so they cannot contradict
     each other: attempted-but-unanswered is Contacting, and it is NOT ready.
     While readiness read the weaker attempt fact, three no_answer calls plus a
     filled-in form presented as "Ready to convert" — Ready takes precedence in
     the ladder — for a customer nobody had ever spoken to. */
  const lead = await draft({ phone: "9876500055" });
  await Lead.updateOne({ _id: lead._id }, { $set: {
    prospectType: "company", source: "referral",
    pendingFirstAction: { subject: "Send the catalogue", dueDate: new Date(dueDate) },
  } });
  for (let i = 0; i < 3; i += 1) {
    await Activity.create({
      leadId: lead._id, activityType: "call", subject: `Attempt ${i}`,
      status: "completed", completedAt: new Date(), outcome: "no_answer",
      ownerId: SALES_USER.id,
    });
  }
  const r = await call(`/${lead._id}/readiness`);
  expect(r.body.checks.find((c) => c.key === "interaction").met).toBe(false);
  expect(r.body.readyToConfirm).toBe(false);

  const ws = await workStateOf(lead._id);
  expect(ws.code).toBe(work.STATES.CONTACTING);
  expect(ws.lastContactAt).toBe(null);

  // and one answered call clears both at once
  await act(lead._id);
  const after = await call(`/${lead._id}/readiness`);
  expect(after.body.readyToConfirm).toBe(true);
  expect(await stateOf(lead._id)).toBe(work.STATES.READY);
});

test("last contact means the last time they engaged, not the last attempt", async () => {
  /* Taking the latest attempt would report a run of unanswered calls as recent
     contact — the opposite of what it is. */
  const lead = await draft();
  await act(lead._id, { completedAt: new Date("2026-09-01T10:00:00Z") });
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Later, no answer",
    status: "completed", completedAt: new Date("2026-09-09T10:00:00Z"),
    outcome: "no_answer", ownerId: SALES_USER.id,
  });
  const ws = (await call(`/${lead._id}`)).body.lead.workState;
  expect(new Date(ws.lastContactAt).toISOString()).toMatch(/^2026-09-01/);
});

/* ══ LEGACY RECORDS SAY ONE THING, ON BOTH SCREENS ═════════════════════════ */

test("a legacy record carries its review status in the same derived object", async () => {
  /* The card preferred the derived state and the header preferred the review
     status, so one Prospect read "Contacting" in the queue and "In Review"
     when opened. Both now read this. */
  for (const status of ["submitted", "returned", "rejected"]) {
    const lead = await draft({ company: `Legacy ${status}` });
    await Lead.updateOne({ _id: lead._id }, { $set: { reviewStatus: status } });
    const ws = (await call(`/${lead._id}`)).body.lead.workState;
    expect(ws.legacy).toBe(status);
  }
});

test("an ordinary Prospect carries no legacy marker", async () => {
  const lead = await draft();
  const ws = (await call(`/${lead._id}`)).body.lead.workState;
  expect(ws.legacy).toBeNull();
});
