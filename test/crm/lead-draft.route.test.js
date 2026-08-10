// test/crm/lead-draft.route.test.js
//
// Draft Lead chunk — HTTP-level tests for the two-tier Quick Capture / Draft
// workspace / Activate lifecycle. Mirrors lead-capture.route.test.js's
// harness (bare Express app, mocked SalesAuthMiddlewear + changeLog, real
// Mongoose against the in-memory Mongo from test/setup.js). Manager-level
// access is exercised against the REAL DepartmentRole collection
// (services/salesAccess.js's live lookup path) rather than mocked, matching
// this suite's existing preference for integration-realism over mocking.
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
// GET /:id populates `assignedTo` against SalesDepartment — registering the
// model here is what earlier lead test files never needed (none of them
// called GET /:id), not a route change.
require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };
const OTHER_SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Deepak Nair", role: "sales", email: "deepak@example.com" };
const APPROVER_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Menon", role: "sales", email: "priya@example.com" };
const CEO_USER = { id: new mongoose.Types.ObjectId().toString(), name: "CEO", role: "ceo", email: "ceo@example.com" };

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
  await DepartmentRole.create({ departmentSlug: "sales", email: APPROVER_USER.email, name: APPROVER_USER.name, role: "approver" });
});

async function call(path = "", { method = "GET", body, user = SALES_USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
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

async function createArchivedDraft(over = {}, user = SALES_USER) {
  const lead = await createDraft(over, user);
  await call(`/${lead._id}/archive-draft`, { method: "PATCH", user });
  return lead;
}

const dueDate = "2026-09-15T09:00:00.000Z";

// Every field the SUBMISSION checklist (services/leadReadiness.js
// computeSubmissionReadiness) requires — so a Prospect built from these is
// submission-ready and can be submitted to a HOD.
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

// A Prospect with the full submission checklist satisfied; returns its id.
async function submittableDraft(over = {}, user = SALES_USER) {
  const lead = await createDraft(over, user);
  await call(`/${lead._id}`, { method: "PATCH", body: SUBMISSION_FIELDS, user });
  return lead._id;
}

/* ── Quick Capture (draft creation) ──────────────────────────────────────── */

describe("POST /leads — Quick Capture (captureStatus: draft)", () => {
  test("creates a draft with qualificationState 'new' and no real Activity, even if company-only", async () => {
    const { status, body } = await call("/", { method: "POST", body: { captureStatus: "draft", company: "Zenith Apparel" } });
    expect(status).toBe(201);
    expect(body.lead.captureStatus).toBe("draft");
    expect(body.lead.qualificationState).toBe("new");
    expect(body.activity).toBeNull();
    expect(await Activity.countDocuments({ leadId: body.lead._id })).toBe(0);
  });

  test("still requires company or firstName — same rule as active capture", async () => {
    const { status, body } = await call("/", { method: "POST", body: { captureStatus: "draft", phone: "9876543210" } });
    expect(status).toBe(400);
    expect(body.message).toMatch(/company name or a first name/i);
  });

  test("a firstAction supplied at draft creation is stored as pendingFirstAction, not a real Activity", async () => {
    const { body } = await call("/", {
      method: "POST",
      body: { captureStatus: "draft", company: "Zenith Apparel", firstAction: { subject: "Call to introduce", dueDate } },
    });
    expect(body.lead.pendingFirstAction.subject).toBe("Call to introduce");
    expect(new Date(body.lead.pendingFirstAction.dueDate).toISOString()).toBe(dueDate);
    expect(body.lead.nextFollowUpAt).toBeFalsy();
    expect(body.activity).toBeNull();
  });

  test("owner defaults to the creator silently, same as active capture", async () => {
    const lead = await createDraft();
    expect(lead.assignedTo).toBe(SALES_USER.id);
  });
});

/* ── Draft visibility ─────────────────────────────────────────────────────── */

describe("Draft visibility — creator, assigned owner, and managers only", () => {
  test("GET / with no captureStatus param excludes drafts entirely", async () => {
    await createDraft();
    const { body } = await call("/");
    expect(body.leads.length).toBe(0);
  });

  test("the creator sees their own draft under captureStatus=draft", async () => {
    await createDraft();
    const { body } = await call("/?captureStatus=draft");
    expect(body.leads.length).toBe(1);
  });

  test("a different ordinary salesperson cannot see someone else's draft in the list", async () => {
    await createDraft();
    const { body } = await call("/?captureStatus=draft", { user: OTHER_SALES_USER });
    expect(body.leads.length).toBe(0);
  });

  test("a manager (department approver) sees everyone's drafts", async () => {
    await createDraft();
    const { body } = await call("/?captureStatus=draft", { user: APPROVER_USER });
    expect(body.leads.length).toBe(1);
  });

  test("a CEO (org-level role) sees everyone's drafts without a DepartmentRole row", async () => {
    await createDraft();
    const { body } = await call("/?captureStatus=draft", { user: CEO_USER });
    expect(body.leads.length).toBe(1);
  });

  test("GET /:id — the creator can open their own draft", async () => {
    const lead = await createDraft();
    const { status } = await call(`/${lead._id}`);
    expect(status).toBe(200);
  });

  test("GET /:id — a different ordinary salesperson is refused with 403", async () => {
    const lead = await createDraft();
    const { status, body } = await call(`/${lead._id}`, { user: OTHER_SALES_USER });
    expect(status).toBe(403);
    expect(body.message).toMatch(/don't have access/i);
  });

  test("GET /:id — a manager can open any draft", async () => {
    const lead = await createDraft();
    const { status } = await call(`/${lead._id}`, { user: APPROVER_USER });
    expect(status).toBe(200);
  });

  test("captureStatus=all for a non-manager: sees active + own drafts, never someone else's draft", async () => {
    await createDraft({ firstName: "Mine Draft" }); // SALES_USER's own draft
    await createDraft({ firstName: "Their Draft" }, OTHER_SALES_USER); // another rep's draft
    await call("/", { method: "POST", body: { firstName: "Active One" } }); // active — open to all
    const { body } = await call("/?captureStatus=all");
    const names = body.leads.map((l) => l.firstName).sort();
    expect(names).toEqual(["Active One", "Mine Draft"]); // NOT "Their Draft"
  });

  test("captureStatus=all for a manager includes everyone's drafts and active leads", async () => {
    await createDraft(); // SALES_USER's draft
    await createDraft({ firstName: "Theirs" }, OTHER_SALES_USER); // another rep's draft
    await call("/", { method: "POST", body: { firstName: "Active One" } });
    const { body } = await call("/?captureStatus=all", { user: APPROVER_USER });
    expect(body.leads.length).toBe(3);
  });
});

/* ── Qualification is locked while a Draft ───────────────────────────────── */

describe("A Draft cannot move through qualification states", () => {
  test("PATCH /:id/qualification-state is refused", async () => {
    const lead = await createDraft();
    const { status, body } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "contacted" },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/approved as an active lead first/i);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.qualificationState).toBe("new");
  });
});

/* ── Readiness checklist (now the SUBMISSION bar) ─────────────────────────────
   The full Prospect → HOD Review → Active Lead workflow (submit / approve /
   return / reject, the submitted read-only lock, HOD-only enforcement) is
   covered exhaustively in test/crm/lead-review.route.test.js. Here we only
   sanity-check that GET /:id/readiness now returns the submission checklist
   for a Prospect, and that the old "start working" bar is gone. */

describe("GET /:id/readiness — submission checklist for a Prospect", () => {
  test("a bare draft is not submission-ready and exposes the submission checks", async () => {
    const lead = await createDraft(); // company only
    const { status, body } = await call(`/${lead._id}/readiness`);
    expect(status).toBe(200);
    expect(body.ready).toBe(false);
    const byKey = Object.fromEntries(body.checks.map((c) => [c.key, c.met]));
    expect(byKey.identity).toBe(true); // company was given
    // The submission bar (not the retired "start working" bar): segment,
    // justification, annual estimates + confidence, evidence, first action.
    expect(byKey.source).toBe(false);
    expect(byKey.segment).toBe(false);
    expect(byKey.justification).toBe(false);
    expect(byKey.annualQuantity).toBe(false);
    expect(byKey.evidence).toBe(false);
    // The old keys are gone — contact info / owner were never submission reqs.
    expect(byKey.owner).toBeUndefined();
    expect(byKey.contactRoute).toBeUndefined();
  });

  test("becomes submission-ready only once every required field is filled", async () => {
    const id = await submittableDraft();
    const { body } = await call(`/${id}/readiness`);
    expect(body.ready).toBe(true);
  });

  test("a strong duplicate match is surfaced but never gates readiness", async () => {
    await createDraft({ phone: "9998887770" }, APPROVER_USER); // pre-existing sharing the phone
    const id = await submittableDraft({ phone: "9998887770" });
    const { body } = await call(`/${id}/readiness`);
    expect(body.ready).toBe(true);
    expect(body.leadMatches.length).toBeGreaterThan(0);
  });
});

/* ── Archive Draft ────────────────────────────────────────────────────────── */

describe("PATCH /:id/archive-draft", () => {
  test("archives a draft and records who/when, separately from the general hard-archive fields", async () => {
    const lead = await createDraft();
    const { status, body } = await call(`/${lead._id}/archive-draft`, { method: "PATCH" });
    expect(status).toBe(200);
    expect(body.lead.captureStatus).toBe("archived");
    expect(body.lead.draftArchivedBy.name).toBe(SALES_USER.name);
    expect(body.lead.draftArchivedAt).toBeTruthy();
    expect(body.lead.isActive).toBe(true); // NOT the general soft-delete
    expect(body.lead.archivedAt).toBeFalsy();
  });

  test("cannot archive-draft an already-active Lead", async () => {
    const { body: created } = await call("/", { method: "POST", body: { firstName: "Active One" } });
    const { status, body } = await call(`/${created.lead._id}/archive-draft`, { method: "PATCH" });
    expect(status).toBe(400);
    expect(body.message).toMatch(/only a prospect can be archived/i);
  });

  test("archived drafts drop out of captureStatus=draft, and are visible under captureStatus=archived to creator/owner and managers only", async () => {
    const lead = await createDraft();
    await call(`/${lead._id}/archive-draft`, { method: "PATCH" });

    // No longer a draft.
    const asDraft = await call("/?captureStatus=draft");
    expect(asDraft.body.leads.length).toBe(0);

    // The creator (an ordinary salesperson) CAN list their own archived draft —
    // archived visibility mirrors draft visibility, no manager-only downgrade.
    const asCreator = await call("/?captureStatus=archived");
    expect(asCreator.body.leads.length).toBe(1);

    // A different ordinary salesperson cannot see it.
    const asOther = await call("/?captureStatus=archived", { user: OTHER_SALES_USER });
    expect(asOther.body.leads.length).toBe(0);

    // A manager can.
    const asManager = await call("/?captureStatus=archived", { user: APPROVER_USER });
    expect(asManager.body.leads.length).toBe(1);
  });
});

/* ── Legacy records and pipeline stats ───────────────────────────────────── */

describe("Legacy records (no captureStatus field) and pipeline stats", () => {
  test("a Lead created without captureStatus behaves as active by default", async () => {
    const { body } = await call("/", { method: "POST", body: { firstName: "Plain" } });
    expect(body.lead.captureStatus).toBe("active");
  });

  test("a document with NO captureStatus at all (pre-chunk data) still appears in the default active list", async () => {
    await Lead.collection.insertOne({
      leadId: "LEAD-2020-9999",
      firstName: "PreChunk",
      qualificationState: "new",
      stage: "new",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { body } = await call("/");
    expect(body.leads.some((l) => l.leadId === "LEAD-2020-9999")).toBe(true);
  });

  test("pipeline stats exclude drafts", async () => {
    await createDraft();
    await call("/", { method: "POST", body: { firstName: "Active One" } });
    const { body } = await call("/");
    expect(body.pipelineStats.total).toBe(1);
  });

  test("pipeline stats exclude archived drafts too", async () => {
    await createArchivedDraft();
    await call("/", { method: "POST", body: { firstName: "Active One" } });
    const { body } = await call("/");
    expect(body.pipelineStats.total).toBe(1);
  });

  test("a legacy doc with no captureStatus DOES count in pipeline stats (treated as active)", async () => {
    await Lead.collection.insertOne({
      leadId: "LEAD-2020-8888",
      firstName: "PreChunk",
      qualificationState: "new",
      stage: "new",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await createArchivedDraft(); // must NOT count
    await createDraft(); // must NOT count
    const { body } = await call("/");
    expect(body.pipelineStats.total).toBe(1); // only the legacy active doc
  });
});

/* ── Archived draft state integrity (regression) ─────────────────────────────
   Archived drafts are excluded from every active surface, share draft
   visibility, and are strictly read-only. */

describe("Archived draft — excluded from active surfaces", () => {
  test("does not appear in the default active list", async () => {
    await createArchivedDraft();
    const { body } = await call("/");
    expect(body.leads.length).toBe(0);
  });

  test("does not appear even in captureStatus=active", async () => {
    await createArchivedDraft();
    const { body } = await call("/?captureStatus=active");
    expect(body.leads.length).toBe(0);
  });
});

describe("Archived draft — visibility (creator, owner, managers only)", () => {
  test("GET /:id — the creator can open it", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}`);
    expect(status).toBe(200);
  });

  test("GET /:id — a different ordinary salesperson is refused with 403", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}`, { user: OTHER_SALES_USER });
    expect(status).toBe(403);
  });

  test("GET /:id — a manager can open it", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}`, { user: APPROVER_USER });
    expect(status).toBe(200);
  });
});

describe("Archived draft — read-only", () => {
  test("PATCH /:id (generic edit) is refused with 409", async () => {
    const lead = await createArchivedDraft();
    const { status, body } = await call(`/${lead._id}`, { method: "PATCH", body: { notes: "trying to edit" } });
    expect(status).toBe(409);
    expect(body.message).toMatch(/archived and read-only/i);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.notes).toBeFalsy();
  });

  test("POST /:id/activities is refused with 409", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "note", subject: "Should not be logged" },
    });
    expect(status).toBe(409);
    expect(await Activity.countDocuments({ leadId: lead._id })).toBe(0);
  });

  test("POST /:id/activity (legacy) is refused with 409", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}/activity`, { method: "POST", body: { type: "note", title: "x" } });
    expect(status).toBe(409);
  });

  test("PATCH /:id/qualification-state is refused with 409", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "contacted" },
    });
    expect(status).toBe(409);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.qualificationState).toBe("new");
    expect(stored.captureStatus).toBe("archived");
  });

  test("PATCH /:id/stage (legacy) is refused with 409", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}/stage`, { method: "PATCH", body: { stage: "contacted" } });
    expect(status).toBe(409);
  });

  test("POST /:id/review-duplicates is refused with 409", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}/review-duplicates`, { method: "POST" });
    expect(status).toBe(409);
  });

  test("POST /:id/submit is refused (an archived Prospect can never be submitted for review)", async () => {
    const lead = await createArchivedDraft();
    const { status, body } = await call(`/${lead._id}/submit`, { method: "POST" });
    expect(status).toBe(400);
    expect(body.message).toMatch(/only a prospect can be submitted/i);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.captureStatus).toBe("archived");
  });

  test("archive-draft on an already-archived draft is refused", async () => {
    const lead = await createArchivedDraft();
    const { status } = await call(`/${lead._id}/archive-draft`, { method: "PATCH" });
    expect(status).toBe(400);
  });

  test("an ACTIVE lead is unaffected — still editable and its qualification still moves", async () => {
    const { body: created } = await call("/", { method: "POST", body: { firstName: "Active One", phone: "9800000000" } });
    const edit = await call(`/${created.lead._id}`, { method: "PATCH", body: { notes: "fine" } });
    expect(edit.status).toBe(200);
    await Activity.create({ leadId: created.lead._id, activityType: "call", subject: "Intro", status: "completed", outcome: "replied_connected" });
    const move = await call(`/${created.lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    expect(move.status).toBe(200);
  });
});
