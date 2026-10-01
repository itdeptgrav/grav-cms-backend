// test/crm/call-schedule.route.test.js
//
// HTTP-level tests for routes/CMS_Routes/Sales/callSchedule.js's
// POST /:id/complete — the Call Planner endpoint that touches a Lead. Added
// for Lead Chunk 1 review item 3: Call Planner must follow the same
// compatibility rules as leads.js (no proposal/negotiation/won, no faked
// conversion, no new embedded-activity writes), routed through the SAME
// services/leadQualification.js so it cannot drift from leads.js's rules.
//
// Same harness pattern as test/crm/lead.route.test.js and
// test/crm/sales-journey.route.test.js: bare Express app + fetch,
// SalesAuthMiddlewear and recordChange mocked.
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

const { recordChange } = require("../../services/changeLog");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const CallSchedule = require("../../models/CMS_Models/Sales/CallSchedule");
const { createWithRef, _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server, leadsBase;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/call-schedules", require("../../routes/CMS_Routes/Sales/callSchedule"));
  /* Mounted alongside so one test can prove the difference between the two
     routes directly: the same move, refused here and accepted there. */
  app.use("/api/cms/crm/leads", require("../../routes/CMS_Routes/Sales/leads"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/call-schedules`;
  leadsBase = `http://127.0.0.1:${server.address().port}/api/cms/crm/leads`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  recordChange.mockClear();
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

async function leadAndSchedule(leadOver = {}) {
  const lead = await createWithRef(Lead, { firstName: "Ravi", lastName: "Kumar", company: "ABC Textiles", phone: "9800000000", ...leadOver });
  const schedule = await CallSchedule.create({
    entityType: "lead",
    entityId: lead._id,
    entityModel: "Lead",
    entityName: "Ravi Kumar",
    scheduledAt: new Date(),
  });
  return { lead, schedule };
}


/* ── ONE COMPANY, SO OWNERSHIP CAN BE PROVED (Chunk 3B1) ─────────────────────
 * Lead and Contact reads are company-scoped now. This suite is not about
 * tenancy, so it seeds the simplest thing that makes ownership provable: a
 * single company, the documented deployment fallback. */
beforeEach(async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  if (!(await Acc_Company.countDocuments({}))) {
    await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  }
});

describe("POST /call-schedules/:id/complete — Lead compatibility (review item 3)", () => {
  test("logs the completed call via shared CRMActivity, not the embedded lead.activities[]", async () => {
    const { lead, schedule } = await leadAndSchedule();
    const { status, body } = await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "interested", feedbackNotes: "Wants a quote next week" },
    });
    expect(status).toBe(200);
    expect(body.schedule.status).toBe("completed");

    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.activities.length).toBe(0);

    const activity = await Activity.findOne({ leadId: lead._id }).lean();
    expect(activity).toBeTruthy();
    expect(activity.activityType).toBe("call");
    expect(activity.outcome).toBe("interested");
    expect(activity.status).toBe("completed");
  });

  test("preserves existing embedded activities from before this chunk (read-only, never migrated)", async () => {
    const { lead, schedule } = await leadAndSchedule();
    await Lead.updateOne(
      { _id: lead._id },
      { $push: { activities: { type: "call", title: "Old-style logged call", completedAt: new Date() } } },
    );
    await call(`/${schedule._id}/complete`, { method: "POST", body: { outcome: "interested" } });

    const storedLead = await Lead.findById(lead._id).lean();
    // The pre-existing entry survives untouched; the endpoint only adds a
    // NEW CRMActivity, never a second embedded entry.
    expect(storedLead.activities.length).toBe(1);
    expect(storedLead.activities[0].title).toBe("Old-style logged call");
  });

  test("does not assign proposal_sent/negotiation/won, and does not fake a conversion — the call itself still completes", async () => {
    for (const newLeadStage of ["proposal_sent", "negotiation", "won"]) {
      const { lead, schedule } = await leadAndSchedule();
      const { status, body } = await call(`/${schedule._id}/complete`, {
        method: "POST",
        body: { outcome: "follow_up_needed", newLeadStage },
      });
      // The call completion itself succeeds even though the stage request
      // was rejected — see leadUpdate.applied below.
      expect(status).toBe(200);
      expect(body.leadUpdate.applied).toBe(false);

      const storedLead = await Lead.findById(lead._id).lean();
      expect(storedLead.stage).toBe("new");
      expect(storedLead.probability).toBe(20);
      expect(storedLead.convertedToCustomer).toBe(false);
      expect(storedLead.convertedAt).toBeFalsy();
    }
  });

  /* ══ COMPLETING A CALL DOES NOT MOVE A LEAD ═════════════════════════════
   * These used to prove the opposite: that ticking off a call could take a
   * Lead to "contacted", and later to "qualified".
   *
   * The Lead lifecycle is decided by requirement evidence, and a call is not
   * requirement evidence — it is a record that a conversation happened. Two
   * writers for one field is how the two disagree, and a stage that moved
   * because somebody closed a call reminder is a stage nobody can explain.
   * ═════════════════════════════════════════════════════════════════════════ */

  test("newLeadStage 'qualified' completes the call but does NOT move the Lead", async () => {
    const { lead, schedule } = await leadAndSchedule({
      // everything the requirement gate would want, so the refusal is clearly
      // about the route and not about an unmet checklist
      requirementItems: [{ product: "Shirts", quantity: 300 }],
      requirementCertainty: "suspected",
    });
    const { status, body } = await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "interested", newLeadStage: "qualified" },
    });

    expect(status).toBe(200);
    expect(body.leadUpdate.applied).toBe(false);
    expect(body.leadUpdate.message).toMatch(/requirement workflow|no longer changes/i);
    // and it reports the UNCHANGED state back, rather than the one asked for
    expect(body.leadUpdate.qualificationState).toBe("new");

    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.qualificationState).toBe("new");
    expect(storedLead.stage).toBe("new");
  });

  test("newLeadStage 'lost' does not change the Lead either", async () => {
    /* Losing a Lead is a decision with a reason attached, taken on the Lead.
       It is not a side effect of closing a call reminder. */
    const { lead, schedule } = await leadAndSchedule();
    const { status, body } = await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "not_interested", feedbackNotes: "Went with a competitor", newLeadStage: "lost" },
    });

    expect(status).toBe(200);
    expect(body.leadUpdate.applied).toBe(false);

    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.qualificationState).toBe("new");
    expect(storedLead.qualificationReason).toBeUndefined();
  });

  test("an old client sending newLeadStage is not failed — the call still completes fully", async () => {
    const { lead, schedule } = await leadAndSchedule();
    const due = "2026-12-01T09:00:00.000Z";
    const { status } = await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "interested", feedbackNotes: "Wants a quote", callDurationActual: 240, nextFollowUpAt: due, newLeadStage: "qualified" },
    });
    expect(status).toBe(200);

    // the schedule itself
    const storedSchedule = await CallSchedule.findById(schedule._id).lean();
    expect(storedSchedule.status).toBe("completed");
    expect(storedSchedule.outcome).toBe("interested");
    expect(storedSchedule.feedbackNotes).toBe("Wants a quote");
    expect(storedSchedule.callDurationActual).toBe(240);
    // the refused stage is NOT recorded as though it took effect
    expect(storedSchedule.newLeadStage).toBeUndefined();

    // the Activity
    const activity = await Activity.findOne({ leadId: lead._id, activityType: "call" }).lean();
    expect(activity).toBeTruthy();
    expect(activity.status).toBe("completed");
    expect(activity.outcome).toBe("interested");

    // and the two things a completed call really does know
    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.lastContactedAt).toBeTruthy();
    expect(new Date(storedLead.nextFollowUpAt).toISOString()).toBe(due);
  });

  test("the qualification endpoint remains the only ordinary way to move a Lead", async () => {
    const { lead, schedule } = await leadAndSchedule({
      requirementItems: [{ product: "Shirts", quantity: 300 }],
      requirementCertainty: "suspected",
    });
    await call(`/${schedule._id}/complete`, { method: "POST", body: { outcome: "interested", newLeadStage: "qualified" } });
    expect((await Lead.findById(lead._id).lean()).qualificationState).toBe("new");

    // the same move, through the endpoint that owns it
    const r = await fetch(`${leadsBase}/${lead._id}/qualification-state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(SALES_USER) },
      body: JSON.stringify({ qualificationState: "qualified" }),
    });
    expect(r.status).toBe(200);
    expect((await Lead.findById(lead._id).lean()).qualificationState).toBe("qualified");
  });

  test("an unreachable transition (new -> qualified) is rejected without failing the call completion", async () => {
    const { lead, schedule } = await leadAndSchedule();
    const { status, body } = await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "follow_up_needed", newLeadStage: "qualified" },
    });
    expect(status).toBe(200);
    expect(body.leadUpdate.applied).toBe(false);
    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.qualificationState).toBe("new");
  });

  test("still updates lastContactedAt/nextFollowUpAt even when no stage change is requested", async () => {
    const { lead, schedule } = await leadAndSchedule();
    const followUp = "2026-09-15T00:00:00.000Z";
    const { status } = await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "voicemail", nextFollowUpAt: followUp },
    });
    expect(status).toBe(200);
    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.lastContactedAt).toBeTruthy();
    expect(new Date(storedLead.nextFollowUpAt).toISOString()).toBe(followUp);
  });

  test("the recorded 'before' snapshot reflects the Lead's state BEFORE lastContactedAt is mutated, and exactly one Lead audit fires even with no stage change", async () => {
    const { lead, schedule } = await leadAndSchedule();
    const originalLastContactedAt = new Date("2020-01-01T00:00:00.000Z");
    await Lead.updateOne({ _id: lead._id }, { lastContactedAt: originalLastContactedAt });

    await call(`/${schedule._id}/complete`, { method: "POST", body: { outcome: "voicemail" } });

    const leadCalls = recordChange.mock.calls.filter(([, entry]) => entry.entity === "lead");
    // Exactly one Lead audit — previously this branch (no stage change
    // requested) logged none at all, even though lastContactedAt changed.
    expect(leadCalls.length).toBe(1);
    const [, entry] = leadCalls[0];
    // Captured pre-mutation: previously `before` was taken AFTER
    // lastContactedAt was already reassigned, so it wrongly matched `after`.
    expect(new Date(entry.before.lastContactedAt).toISOString()).toBe(originalLastContactedAt.toISOString());
    expect(new Date(entry.after.lastContactedAt).toISOString()).not.toBe(originalLastContactedAt.toISOString());
  });

  test("does not persist a rejected newLeadStage on the CallSchedule", async () => {
    const { schedule } = await leadAndSchedule();
    await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "follow_up_needed", newLeadStage: "won" },
    });
    const storedSchedule = await CallSchedule.findById(schedule._id).lean();
    expect(storedSchedule.newLeadStage).toBeFalsy();
  });

  test("a refused stage move is NOT persisted on the schedule", async () => {
    const { schedule } = await leadAndSchedule();
    await call(`/${schedule._id}/complete`, {
      method: "POST",
      body: { outcome: "interested", newLeadStage: "contacted" },
    });
    const storedSchedule = await CallSchedule.findById(schedule._id).lean();
    expect(storedSchedule.newLeadStage).toBeUndefined();
  });
});
