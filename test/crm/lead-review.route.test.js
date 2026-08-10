// test/crm/lead-review.route.test.js
//
// The Prospect → HOD Review → Active Lead approval workflow (services/
// leadReview.js + the submit/approve/return-for-info/reject routes). Mirrors
// lead-correction.route.test.js's harness: bare Express app, mocked
// SalesAuthMiddlewear (x-test-user header) + changeLog, real Mongoose, and
// real DepartmentRole/SalesDepartment collections so isSalesManager's live
// lookup (the HOD gate) is exercised for real, not mocked.
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
const OTHER_SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Deepak Nair", role: "sales", email: "deepak@example.com" };
const HOD_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Menon", role: "sales", email: "priya@example.com" };

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
  await DepartmentRole.create({ departmentSlug: "sales", email: HOD_USER.email, name: HOD_USER.name, role: "approver" });
  await SalesDepartment.deleteMany({});
  await SalesDepartment.create([
    { _id: SALES_USER.id, email: SALES_USER.email, password: "x", name: SALES_USER.name, employeeId: "EMP-1", phone: "9000000001" },
    { _id: OTHER_SALES_USER.id, email: OTHER_SALES_USER.email, password: "x", name: OTHER_SALES_USER.name, employeeId: "EMP-2", phone: "9000000002" },
    { _id: HOD_USER.id, email: HOD_USER.email, password: "x", name: HOD_USER.name, employeeId: "EMP-3", phone: "9000000003" },
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

const dueDate = "2026-09-15T09:00:00.000Z";

const SUBMISSION_FIELDS = {
  source: "referral",
  industry: "corporate",
  pursuitJustification: "Large annual uniform program — strong fit.",
  estimatedAnnualQuantity: 5000,
  estimatedAnnualQuantityConfidence: "researched",
  estimatedAnnualRevenue: 2000000,
  estimatedAnnualRevenueConfidence: "assumed",
  evidence: [{ claim: "annual_quantity", evidenceType: "tender_notice", sourceUrl: "https://example.com/tender" }],
  pendingFirstAction: { subject: "Intro call with procurement", dueDate },
};

/** A Prospect (captureStatus:"draft", reviewStatus:"researching"). */
async function createProspect(over = {}, user = SALES_USER) {
  const { body } = await call("/", { method: "POST", body: { captureStatus: "draft", company: "Zenith Apparel", ...over }, user });
  return body.lead;
}

/** A Prospect with the full submission checklist satisfied; returns its id. */
async function readyProspect(over = {}, user = SALES_USER) {
  const lead = await createProspect(over, user);
  await call(`/${lead._id}`, { method: "PATCH", body: SUBMISSION_FIELDS, user });
  return lead._id;
}

/** A Prospect that has been submitted and is awaiting HOD review; returns id. */
async function submittedProspect(over = {}, user = SALES_USER) {
  const id = await readyProspect(over, user);
  const r = await call(`/${id}/submit`, { method: "POST", user });
  expect(r.status).toBe(200);
  return id;
}

/* ══════════════════ 1. A new Prospect begins "researching" ═══════════════ */

describe("A new Prospect begins Researching and is separate from qualification", () => {
  test("reviewStatus defaults to researching; qualificationState is independent 'new'", async () => {
    const lead = await createProspect();
    expect(lead.reviewStatus).toBe("researching");
    expect(lead.qualificationState).toBe("new");
    expect(lead.captureStatus).toBe("draft");
  });

  test("a directly-created Active Lead (legacy one-shot) is 'approved', not researching", async () => {
    const { body } = await call("/", { method: "POST", body: { firstName: "Direct" } });
    expect(body.lead.captureStatus).toBe("active");
    expect(body.lead.reviewStatus).toBe("approved");
  });
});

/* ═══════════════════════════ 2. Submit to HOD ════════════════════════════ */

describe("POST /:id/submit — submission readiness + state", () => {
  test("refuses a Prospect missing required submission fields, returning the checklist", async () => {
    const lead = await createProspect(); // company only
    const { status, body } = await call(`/${lead._id}/submit`, { method: "POST" });
    expect(status).toBe(400);
    expect(body.checks).toBeTruthy();
    const missing = body.checks.filter((c) => !c.met).map((c) => c.key);
    expect(missing).toEqual(expect.arrayContaining(["source", "segment", "justification", "annualQuantity", "annualRevenue", "evidence", "firstAction"]));
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.reviewStatus).toBe("researching"); // not persisted
  });

  test("requires confidence for BOTH estimates and at least one evidence URL/ref", async () => {
    const lead = await createProspect();
    // Everything except the two confidences and evidence.
    await call(`/${lead._id}`, { method: "PATCH", body: {
      source: "referral", industry: "corporate", pursuitJustification: "why",
      estimatedAnnualQuantity: 100, estimatedAnnualRevenue: 100,
      pendingFirstAction: { subject: "call", dueDate },
    } });
    const r1 = await call(`/${lead._id}/submit`, { method: "POST" });
    expect(r1.status).toBe(400);
    const missing = r1.body.checks.filter((c) => !c.met).map((c) => c.key);
    expect(missing).toEqual(expect.arrayContaining(["annualQuantityConfidence", "annualRevenueConfidence", "evidence"]));
  });

  test("submits a ready Prospect: reviewStatus -> submitted, captureStatus still draft", async () => {
    const id = await readyProspect();
    const { status, body } = await call(`/${id}/submit`, { method: "POST" });
    expect(status).toBe(200);
    expect(body.lead.reviewStatus).toBe("submitted");
    expect(body.lead.captureStatus).toBe("draft");
    expect(body.lead.submittedBy.id).toBe(SALES_USER.id);
  });

  test("a Prospect cannot be submitted twice", async () => {
    const id = await submittedProspect();
    const { status, body } = await call(`/${id}/submit`, { method: "POST" });
    expect(status).toBe(400);
    expect(body.message).toMatch(/researching or returned/i);
  });
});

/* ══════════════ 3. Submitted Prospects are read-only for the rep ══════════ */

describe("A submitted Prospect is read-only until reviewed", () => {
  test("generic field edits are refused with 409 while submitted", async () => {
    const id = await submittedProspect();
    const { status, body } = await call(`/${id}`, { method: "PATCH", body: { notes: "sneaky edit" } });
    expect(status).toBe(409);
    expect(body.message).toMatch(/submitted for hod review/i);
  });

  test("archive-draft is refused while submitted (a HOD rejects instead)", async () => {
    const id = await submittedProspect();
    const { status } = await call(`/${id}/archive-draft`, { method: "PATCH" });
    expect(status).toBe(409);
  });
});

/* ═══════════════ 4. Only a HOD/admin approval makes an Active Lead ════════ */

describe("POST /:id/approve — HOD only, and the only path to Active Lead", () => {
  test("an ordinary salesperson (even the owner) cannot approve", async () => {
    const id = await submittedProspect();
    const { status, body } = await call(`/${id}/approve`, { method: "POST", user: SALES_USER });
    expect(status).toBe(403);
    expect(body.message).toMatch(/only a hod or admin/i);
    expect((await Lead.findById(id).lean()).captureStatus).toBe("draft");
  });

  test("a HOD approves a submitted Prospect as an Active Lead: captureStatus active, reviewStatus approved, qualification stays new, Activity created", async () => {
    const id = await submittedProspect();
    const { status, body } = await call(`/${id}/approve`, { method: "POST", user: HOD_USER });
    expect(status).toBe(200);
    expect(body.lead.captureStatus).toBe("active");
    expect(body.lead.reviewStatus).toBe("approved");
    expect(body.lead.qualificationState).toBe("new");
    expect(new Date(body.lead.nextFollowUpAt).toISOString()).toBe(dueDate);
    expect(body.activity.activityType).toBe("follow_up");
    expect(body.activity.status).toBe("planned");
    expect(await Activity.countDocuments({ leadId: id })).toBe(1);
  });

  test("approval cannot be applied to a Prospect that isn't submitted", async () => {
    const id = await readyProspect(); // still researching
    const { status, body } = await call(`/${id}/approve`, { method: "POST", user: HOD_USER });
    expect(status).toBe(400);
    expect(body.message).toMatch(/awaiting hod review/i);
  });

  test("by default the creator becomes owner after approval", async () => {
    const id = await submittedProspect();
    const { body } = await call(`/${id}/approve`, { method: "POST", user: HOD_USER });
    expect(body.lead.assignedTo).toBe(SALES_USER.id);
    expect(body.lead.assignedToName).toBe(SALES_USER.name);
  });

  test("the HOD may assign another owner INSIDE the approval action, with a server-derived name", async () => {
    const id = await submittedProspect();
    const { body } = await call(`/${id}/approve`, { method: "POST", body: { assignedTo: OTHER_SALES_USER.id, assignedToName: "Spoofed" }, user: HOD_USER });
    expect(body.lead.assignedTo).toBe(OTHER_SALES_USER.id);
    expect(body.lead.assignedToName).toBe(OTHER_SALES_USER.name); // NOT "Spoofed"
    // The first Activity is owned by the new owner too.
    const activity = await Activity.findOne({ leadId: id }).lean();
    expect(activity.ownerId.toString()).toBe(OTHER_SALES_USER.id);
  });

  test("an approved Active Lead appears in the default active Inbox", async () => {
    const id = await submittedProspect();
    await call(`/${id}/approve`, { method: "POST", user: HOD_USER });
    const { body } = await call("/");
    expect(body.leads.map((l) => l._id)).toContain(id);
  });

  test("reliability: if the first Activity write fails, the Prospect is NOT flipped to active", async () => {
    const id = await submittedProspect();
    const spy = jest.spyOn(Activity, "create").mockRejectedValueOnce(new Error("simulated write failure"));
    const { status } = await call(`/${id}/approve`, { method: "POST", user: HOD_USER });
    expect(status).toBe(400);
    spy.mockRestore();
    const stored = await Lead.findById(id).lean();
    expect(stored.captureStatus).toBe("draft");
    expect(stored.reviewStatus).toBe("submitted"); // never persisted the approval
    expect(await Activity.countDocuments({ leadId: id })).toBe(0);
  });

  test("there is no direct-activation path any more — POST /:id/activate is gone (404)", async () => {
    const id = await submittedProspect();
    // The route no longer exists — Express answers with its default 404 (HTML,
    // not our JSON), so don't parse the body, just assert it's not found.
    const res = await fetch(`${base}/${id}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(SALES_USER) },
    });
    expect(res.status).toBe(404);
  });
});

/* ═══════════════ 5. Return for more info, and re-submission ═══════════════ */

describe("POST /:id/return-for-info — HOD only, reason required, then re-submittable", () => {
  test("a salesperson cannot return; a HOD must give a reason", async () => {
    const id = await submittedProspect();
    expect((await call(`/${id}/return-for-info`, { method: "POST", body: { reason: "x" }, user: SALES_USER })).status).toBe(403);
    const noReason = await call(`/${id}/return-for-info`, { method: "POST", user: HOD_USER });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason is required/i);
  });

  test("returned Prospects become editable again and can be resubmitted", async () => {
    const id = await submittedProspect();
    const ret = await call(`/${id}/return-for-info`, { method: "POST", body: { reason: "Add a firmer revenue basis" }, user: HOD_USER });
    expect(ret.status).toBe(200);
    expect(ret.body.lead.reviewStatus).toBe("returned");
    expect(ret.body.lead.reviewReason).toBe("Add a firmer revenue basis");

    // Editable again (no longer 409).
    const edit = await call(`/${id}`, { method: "PATCH", body: { estimatedAnnualRevenueConfidence: "contact_confirmed" } });
    expect(edit.status).toBe(200);

    // And re-submittable.
    const resubmit = await call(`/${id}/submit`, { method: "POST" });
    expect(resubmit.status).toBe(200);
    expect(resubmit.body.lead.reviewStatus).toBe("submitted");
    // Re-submission clears the prior return reason.
    expect(resubmit.body.lead.reviewReason).toBeFalsy();
  });
});

/* ══════════════════════ 6. Reject / Archive (HOD only) ═══════════════════ */

describe("POST /:id/reject — HOD only, reason required, archives the Prospect", () => {
  test("a salesperson cannot reject; a HOD must give a reason", async () => {
    const id = await submittedProspect();
    expect((await call(`/${id}/reject`, { method: "POST", body: { reason: "x" }, user: SALES_USER })).status).toBe(403);
    const noReason = await call(`/${id}/reject`, { method: "POST", user: HOD_USER });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason is required/i);
  });

  test("rejecting archives the Prospect: captureStatus archived, reviewStatus rejected", async () => {
    const id = await submittedProspect();
    const { status, body } = await call(`/${id}/reject`, { method: "POST", body: { reason: "Not a fit for our capacity" }, user: HOD_USER });
    expect(status).toBe(200);
    expect(body.lead.captureStatus).toBe("archived");
    expect(body.lead.reviewStatus).toBe("rejected");
    expect(body.lead.reviewReason).toBe("Not a fit for our capacity");
    expect(body.lead.draftArchivedBy.id).toBe(HOD_USER.id);
    // Excluded from the active Inbox.
    const { body: list } = await call("/");
    expect(list.leads.map((l) => l._id)).not.toContain(id);
  });
});
