// test/crm/lead-correction.route.test.js
//
// HTTP-level tests for the Lead correction chunk — the five gaps identified
// after the Draft Lead / Lead frontend chunks were already live:
//   1. Controlled Lead status (contactAttempted/contacted/nurture/qualified/
//      readyToConvert/disqualified/duplicate prerequisites, enforced in the
//      shared services/leadQualification.js, not only the UI)
//   2. Activity correctness (structured outcomes, lastContactedAt gating,
//      Draft Leads have no Activities, access checks on the activity
//      list/create endpoints)
//   3. Lead information (requirementCertainty; evidence-backed estimates
//      enforced at qualification time, not Draft save)
//   4. Permissions (manager-only reassignment; server-derived employee names)
//   5. Lists (a real Unassigned filter; My Drafts strictly self-scoped)
//
// Mirrors lead-draft.route.test.js's harness exactly (bare Express app,
// mocked SalesAuthMiddlewear + changeLog, real Mongoose, real DepartmentRole/
// SalesDepartment collections for manager-permission realism).
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
const Account = require("../../models/CMS_Models/Sales/Account");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SalesDepartment = require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };
const OTHER_SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Deepak Nair", role: "sales", email: "deepak@example.com" };
const APPROVER_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Menon", role: "sales", email: "priya@example.com" };

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
  await SalesDepartment.deleteMany({});
  await SalesDepartment.create([
    { _id: SALES_USER.id, email: SALES_USER.email, password: "x", name: SALES_USER.name, employeeId: "EMP-1", phone: "9000000001" },
    { _id: OTHER_SALES_USER.id, email: OTHER_SALES_USER.email, password: "x", name: OTHER_SALES_USER.name, employeeId: "EMP-2", phone: "9000000002" },
    { _id: APPROVER_USER.id, email: APPROVER_USER.email, password: "x", name: APPROVER_USER.name, employeeId: "EMP-3", phone: "9000000003" },
  ]);
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

const validBody = (over = {}) => ({ firstName: "Kiran", lastName: "Shah", company: "Test Buyer Co", phone: "9800000000", ...over });
async function createLead(over = {}, user) {
  const { body } = await call("/", { method: "POST", body: validBody(over), user });
  return body.lead;
}

const QUALIFICATION_READY_FIELDS = {
  phone: "9876500000",
  productInterest: ["Shirts"],
  estimatedQuantity: 500,
  requirementDate: "2026-12-01T00:00:00.000Z",
  requirementCertainty: "prospect_confirmed",
  decisionMakerName: "Ravi Kumar",
};

/* ══════════════════════ 1. Controlled Lead status ═══════════════════════ */

describe("1. Controlled Lead status — per-transition prerequisites", () => {
  test("Contacting/Engaged are rejected when the Lead has no phone, WhatsApp or email at all", async () => {
    // A Lead with NO way to reach them cannot be marked contacted, even with a
    // logged activity — you can't have contacted someone you can't reach.
    const lead = await createLead({ phone: "", email: "", whatsapp: "" });
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Claim I called", status: "completed", outcome: "replied_connected" });

    const attempted = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(attempted.status).toBe(400);
    expect(attempted.body.message).toMatch(/no contact details|phone number, WhatsApp or email/i);

    const contacted = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    expect(contacted.status).toBe(400);
    expect(contacted.body.message).toMatch(/no contact details|phone number, WhatsApp or email/i);

    // Add an email → the same moves are now allowed (activity already logged).
    await call(`/${lead._id}`, { method: "PATCH", body: { email: "buyer@testco.example" } });
    const ok = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    expect(ok.status).toBe(200);
  });

  test("Contact Attempted is rejected with no logged outreach attempt, and accepted once one exists", async () => {
    const lead = await createLead();
    const rejected = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toMatch(/logged outreach attempt/i);

    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Tried calling", status: "completed", outcome: "no_answer" });
    const accepted = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(accepted.status).toBe(200);
  });

  test("a task/follow_up (not yet acted on) does not count as an outreach attempt", async () => {
    const lead = await createLead();
    await Activity.create({ leadId: lead._id, activityType: "follow_up", subject: "Plan to call", status: "planned", dueDate: new Date() });
    const { status } = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contactAttempted" } });
    expect(status).toBe(400);
  });

  test("Contacted is rejected with only a No Answer logged, accepted once a successful outcome exists", async () => {
    const lead = await createLead();
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Tried calling", status: "completed", outcome: "no_answer" });
    const rejected = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toMatch(/successful two-way contact/i);

    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    const accepted = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    expect(accepted.status).toBe(200);
  });

  test("Nurture is rejected without reason, next action or follow-up date; accepted with all three", async () => {
    const lead = await createLead();
    const noReason = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "nurture" } });
    expect(noReason.status).toBe(400);

    const noNextAction = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "nurture", reason: "Busy this quarter" },
    });
    expect(noNextAction.status).toBe(400);
    expect(noNextAction.body.message).toMatch(/next action/i);

    const noDueDate = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "nurture", reason: "Busy this quarter", nextAction: { subject: "Check back" } },
    });
    expect(noDueDate.status).toBe(400);
    expect(noDueDate.body.message).toMatch(/follow-up date/i);

    const ok = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "nurture", reason: "Busy this quarter", nextAction: { subject: "Check back", dueDate: "2026-11-01T09:00:00.000Z" } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.lead.qualificationReason).toBe("Busy this quarter");
    expect(new Date(ok.body.lead.nextFollowUpAt).toISOString()).toBe("2026-11-01T09:00:00.000Z");
    // A real, planned follow-up Activity was created, mirroring activation's
    // create-then-persist reliability pattern.
    expect(ok.body.activity).toBeTruthy();
    expect(ok.body.activity.status).toBe("planned");
    const stored = await Activity.findOne({ leadId: lead._id, activityType: "follow_up" }).lean();
    expect(stored).toBeTruthy();
    expect(stored.subject).toBe("Check back");
  });

  test("Qualified is disabled (rejected) until the checklist is genuinely complete, listing what's missing", async () => {
    const lead = await createLead();
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });

    const incomplete = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.message).toMatch(/isn't ready/i);
    // The fixture has a phone (contact route met) but no confirmed requirement
    // or decision-maker — those are what the checklist should still name.
    expect(incomplete.body.message).toMatch(/decision-maker/i);

    // Fill the checklist directly and retry.
    await call(`/${lead._id}`, { method: "PATCH", body: QUALIFICATION_READY_FIELDS });
    const complete = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    expect(complete.status).toBe(200);
  });

  test("Ready to Convert shares the same checklist bar as Qualified", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    // Blank the decision-maker (checklist regresses) and confirm readyToConvert is refused too.
    await call(`/${lead._id}`, { method: "PATCH", body: { decisionMakerName: "" } });
    const { status } = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "readyToConvert" } });
    expect(status).toBe(400);
  });

  test("Ready for Journey needs a credible requirement (product + indicative quantity), NOT a confirmed certainty", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });

    // Certainty is NO LONGER a gate — confirming/finalising quantities is the
    // journey's job (Enquiry → PO), so downgrading it must not block conversion.
    await call(`/${lead._id}`, { method: "PATCH", body: { requirementCertainty: "unknown" } });
    const stillOk = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "readyToConvert" } });
    expect(stillOk.status).toBe(200);

    // But an actually-missing requirement (no product) still blocks it: a Sales
    // Journey is started against a specific, credible requirement.
    const lead2 = await createLead(QUALIFICATION_READY_FIELDS);
    await Activity.create({ leadId: lead2._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    await call(`/${lead2._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    await call(`/${lead2._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    await call(`/${lead2._id}`, { method: "PATCH", body: { productInterest: [] } });
    const blocked = await call(`/${lead2._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "readyToConvert" } });
    expect(blocked.status).toBe(400);
  });

  test("Nurture requires a FUTURE revisit date, not a past one", async () => {
    const lead = await createLead();
    const past = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "nurture", reason: "Busy", nextAction: { subject: "Check back", dueDate: new Date(Date.now() - 86400000).toISOString() } },
    });
    expect(past.status).toBe(400);
    expect(past.body.message).toMatch(/future/i);

    const future = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "nurture", reason: "Busy", nextAction: { subject: "Check back", dueDate: new Date(Date.now() + 30 * 86400000).toISOString() } },
    });
    expect(future.status).toBe(200);
  });

  test("Disqualified requires a reason (unchanged)", async () => {
    const lead = await createLead();
    expect((await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "disqualified" } })).status).toBe(400);
    expect((await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "disqualified", reason: "No budget" } })).status).toBe(200);
  });

  test("Duplicate requires an existing, verified Lead/Account link — a reason alone is not enough", async () => {
    const lead = await createLead();
    const other = await createLead({ firstName: "Existing" });
    const noLink = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "duplicate", reason: "Same buyer" } });
    expect(noLink.status).toBe(400);

    const ok = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "duplicate", reason: "Same buyer", duplicateOf: { type: "lead", id: other._id } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.lead.duplicateOf).toMatchObject({ type: "lead", id: other._id });
  });

  test("Duplicate accepts a genuine Account link too", async () => {
    const lead = await createLead();
    const account = await Account.create({ companyName: "Existing Account Co", createdBy: {}, updatedBy: {} });
    const { status, body } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "duplicate", reason: "Same buyer", duplicateOf: { type: "account", id: account._id.toString() } },
    });
    expect(status).toBe(200);
    expect(body.lead.duplicateOf).toMatchObject({ type: "account", id: account._id.toString() });
  });
});

/* ══════════════════════════ 2. Activity correctness ══════════════════════ */

describe("2. Activity correctness", () => {
  test("Draft Leads reject Activity creation and listing entirely", async () => {
    const { body } = await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Drafty" } });
    const draftId = body.lead._id;

    const list = await call(`/${draftId}/activities`);
    expect(list.status).toBe(400);
    expect(list.body.message).toMatch(/prospects don't have activities/i);

    const create = await call(`/${draftId}/activities`, { method: "POST", body: { activityType: "call", subject: "Too early" } });
    expect(create.status).toBe(400);

    const legacy = await call(`/${draftId}/activity`, { method: "POST", body: { type: "call", title: "Too early" } });
    expect(legacy.status).toBe(400);
  });

  test("GET /:id/activities is refused for a restricted (draft/archived) Lead the caller doesn't own and isn't a manager for", async () => {
    const created = await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Private" }, user: SALES_USER });
    const draftId = created.body.lead._id;
    const asOther = await call(`/${draftId}/activities`, { user: OTHER_SALES_USER });
    expect(asOther.status).toBe(403);
    const asOwner = await call(`/${draftId}/activities`, { user: SALES_USER });
    // Still a draft, so this is refused for the DRAFT reason, not access —
    // confirms access passed and the draft-block is what's speaking.
    expect(asOwner.status).toBe(400);
    expect(asOwner.body.message).toMatch(/prospects don't have activities/i);
    const asManager = await call(`/${draftId}/activities`, { user: APPROVER_USER });
    expect(asManager.status).toBe(400); // manager passes access, still draft-blocked
  });

  test("an outcome outside the structured vocabulary is rejected on both activity-creation endpoints", async () => {
    const lead = await createLead();
    const canonical = await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Call", outcome: "made up value" } });
    expect(canonical.status).toBe(400);
    const legacy = await call(`/${lead._id}/activity`, { method: "POST", body: { type: "call", title: "Call", outcome: "made up value" } });
    expect(legacy.status).toBe(400);
  });

  test("lastContactedAt updates only for No Answer's opposite — a genuinely successful outcome — not for No Answer itself", async () => {
    const lead = await createLead();
    await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Tried", outcome: "no_answer" } });
    expect((await Lead.findById(lead._id).lean()).lastContactedAt).toBeFalsy();
    await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Reached", outcome: "meeting_completed" } });
    expect((await Lead.findById(lead._id).lean()).lastContactedAt).toBeTruthy();
  });
});

/* ══════════════════════════ 3. Lead information ══════════════════════════ */

describe("3. Lead information", () => {
  test("requirementCertainty is a real, persisted, whitelisted field", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}`, { method: "PATCH", body: { requirementCertainty: "document_confirmed" } });
    expect(status).toBe(200);
    expect(body.lead.requirementCertainty).toBe("document_confirmed");
  });

  test("requirementCertainty rejects a value outside its enum", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}`, { method: "PATCH", body: { requirementCertainty: "very sure" } });
    expect(status).toBe(400);
  });

  test("a Draft Lead can save a Researched-confidence estimate with NO evidence — not blocked at save time", async () => {
    const { body } = await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Drafty" } });
    const { status, body: patched } = await call(`/${body.lead._id}`, {
      method: "PATCH",
      body: { estimatedAnnualQuantity: 10000, estimatedAnnualQuantityConfidence: "researched" },
    });
    expect(status).toBe(200);
    expect(patched.lead.estimatedAnnualQuantity).toBe(10000);
  });

  test("a researched estimate is enforced at QUALIFICATION time: Qualified is refused until the figure carries its own inline source", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "contacted" } });
    await call(`/${lead._id}`, { method: "PATCH", body: { estimatedAnnualQuantity: 10000, estimatedAnnualQuantityConfidence: "researched" } });

    const refused = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/evidence/i);

    // The source is attached INLINE to the number — no separate evidence record.
    await call(`/${lead._id}`, { method: "PATCH", body: { estimatedAnnualQuantitySource: "https://example.com/report" } });
    const ok = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    expect(ok.status).toBe(200);
  });
});

/* ══════════════════════════════ 4. Permissions ═══════════════════════════ */

describe("4. Permissions", () => {
  test("an ordinary salesperson cannot assign a NEW Lead to someone else", async () => {
    const { status, body } = await call("/", { method: "POST", body: { firstName: "Handoff", assignedTo: OTHER_SALES_USER.id } });
    expect(status).toBe(403);
  });

  test("an ordinary salesperson CAN confirm themselves as owner (self-assignment is never gated)", async () => {
    const { status } = await call("/", { method: "POST", body: { firstName: "Self", assignedTo: SALES_USER.id } });
    expect(status).toBe(201);
  });

  test("a manager CAN assign a NEW Lead to someone else, and the name is server-derived, not client-trusted", async () => {
    const { status, body } = await call("/", {
      method: "POST",
      body: { firstName: "Handoff", assignedTo: OTHER_SALES_USER.id, assignedToName: "Totally Fake Name" },
      user: APPROVER_USER,
    });
    expect(status).toBe(201);
    expect(body.lead.assignedToName).toBe(OTHER_SALES_USER.name); // NOT "Totally Fake Name"
  });

  test("an ordinary salesperson cannot REASSIGN an existing Lead's owner via PATCH", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}`, { method: "PATCH", body: { assignedTo: OTHER_SALES_USER.id } });
    expect(status).toBe(403);
  });

  test("an ordinary salesperson cannot unassign an existing Lead either — unassigning is still a reassignment", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}`, { method: "PATCH", body: { assignedTo: "" } });
    expect(status).toBe(403);
  });

  test("a manager CAN reassign an existing Lead's owner via PATCH, with a server-derived name", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}`, {
      method: "PATCH",
      body: { assignedTo: OTHER_SALES_USER.id, assignedToName: "Spoofed" },
      user: APPROVER_USER,
    });
    expect(status).toBe(200);
    expect(body.lead.assignedToName).toBe(OTHER_SALES_USER.name);
  });

  test("sourcedBy is gated the same way as assignedTo", async () => {
    const lead = await createLead();
    const denied = await call(`/${lead._id}`, { method: "PATCH", body: { sourcedBy: OTHER_SALES_USER.id } });
    expect(denied.status).toBe(403);
    const allowed = await call(`/${lead._id}`, { method: "PATCH", body: { sourcedBy: OTHER_SALES_USER.id }, user: APPROVER_USER });
    expect(allowed.status).toBe(200);
    expect(allowed.body.lead.sourcedByName).toBe(OTHER_SALES_USER.name);
  });

  test("a field-only PATCH (no assignedTo/sourcedBy present) is never gated, for anyone", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}`, { method: "PATCH", body: { notes: "just a note" } });
    expect(status).toBe(200);
  });
});

/* ═════════════════════════════════ 5. Lists ══════════════════════════════ */

describe("5. Lists", () => {
  test("a real backend Unassigned filter — assignedTo=none — matches only Leads with no owner", async () => {
    await createLead({ firstName: "Owned" }); // defaults to SALES_USER
    await call("/", { method: "POST", body: { firstName: "Unowned", assignedTo: "" }, user: APPROVER_USER });

    const { body } = await call("/?assignedTo=none");
    expect(body.leads.length).toBe(1);
    expect(body.leads[0].firstName).toBe("Unowned");
    expect(body.leads[0].assignedTo).toBeFalsy();
  });

  test("My Drafts (captureStatus=draft&onlyMine=true) never shows another user's draft, even to a manager", async () => {
    await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Mine" }, user: SALES_USER });
    await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "TheirsToo" }, user: APPROVER_USER });

    const asManagerOnlyMine = await call("/?captureStatus=draft&onlyMine=true", { user: APPROVER_USER });
    expect(asManagerOnlyMine.body.leads.length).toBe(1);
    expect(asManagerOnlyMine.body.leads[0].firstName).toBe("TheirsToo");

    // Without onlyMine, a manager still sees everyone's — confirms onlyMine
    // is what's doing the restricting above, not some other default.
    const asManagerAll = await call("/?captureStatus=draft", { user: APPROVER_USER });
    expect(asManagerAll.body.leads.length).toBe(2);
  });

  test("My Drafts for an ordinary (non-manager) salesperson is always self-scoped, onlyMine or not", async () => {
    await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "Mine" }, user: SALES_USER });
    await call("/", { method: "POST", body: { captureStatus: "draft", firstName: "NotMine" }, user: APPROVER_USER });

    const { body } = await call("/?captureStatus=draft", { user: SALES_USER });
    expect(body.leads.length).toBe(1);
    expect(body.leads[0].firstName).toBe("Mine");
  });
});
