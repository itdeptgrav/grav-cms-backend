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

/* ══ THE LEAD LIFECYCLE IS ABOUT THE REQUIREMENT ═══════════════════════════
 * Three tests here used to prove the contact funnel: that Contacting needed a
 * logged outreach attempt, that Contacted needed a successful two-way outcome,
 * and that neither could be reached without a contact route.
 *
 * Every one of those facts is now established BEFORE the record is a Lead. A
 * Prospect converts only on a successful interaction with a confirmed interest
 * signal, so re-asking made a salesperson prove the same thing twice — and
 * told them nothing about the only open question at this stage: what does this
 * customer actually want?
 *
 * The two states are kept so old records stay readable (see lead.test.js for
 * the graph), but nothing targets them, so those tests are replaced by the
 * rules that took their place rather than deleted quietly.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("1. Controlled Lead status — per-transition prerequisites", () => {
  const setState = (id, body) => call(`/${id}/qualification-state`, { method: "PATCH", body });

  test("a converted Prospect starts at Interest Confirmed, not at New-and-uncontacted", async () => {
    const lead = await createLead();
    expect(lead.qualificationState).toBe("new");
    const { LEAD_QUALIFICATION_STATES } = require("../../constants/crm");
    const label = Object.fromEntries(LEAD_QUALIFICATION_STATES.map((x) => [x.code, x.label]));
    expect(label.new).toBe("Interest Confirmed");
  });

  test("no new work can be moved to Contacting or Contacted", async () => {
    const lead = await createLead();
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Reached them", status: "completed", outcome: "replied_connected" });
    for (const target of ["contactAttempted", "contacted"]) {
      const r = await setState(lead._id, { qualificationState: target });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/legacy/i);
    }
    // even with everything the old gates asked for, and from nurture too
    await setState(lead._id, { qualificationState: "nurture", reason: "Busy", nextAction: { subject: "Check back", dueDate: "2026-11-01T09:00:00.000Z" } });
    expect((await setState(lead._id, { qualificationState: "contacted" })).status).toBe(400);
  });

  test("an existing Contacting/Contacted record stays readable and can still advance", async () => {
    /* Compatibility, not migration: the stored value is untouched and the
       record moves straight to Requirement Captured. */
    for (const legacy of ["contactAttempted", "contacted"]) {
      const lead = await createLead(QUALIFICATION_READY_FIELDS);
      await Lead.updateOne({ _id: lead._id }, { $set: { qualificationState: legacy } });

      const read = await call(`/${lead._id}`);
      expect(read.status).toBe(200);
      expect(read.body.lead.qualificationState).toBe(legacy);

      const r = await setState(lead._id, { qualificationState: "qualified" });
      expect(r.status).toBe(200);
      expect(r.body.lead.qualificationState).toBe("qualified");
    }
  });

  test("a legacy record keeps its history when it advances", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await Lead.updateOne({ _id: lead._id }, { $set: { qualificationState: "contacted" } });
    await Activity.create({ leadId: lead._id, activityType: "call", subject: "Old call", status: "completed", outcome: "replied_connected" });

    await setState(lead._id, { qualificationState: "qualified" });
    const acts = await Activity.find({ leadId: lead._id }).lean();
    expect(acts.some((a) => a.subject === "Old call")).toBe(true);
  });

  /* ── REQUIREMENT IDENTIFIED ─────────────────────────────────────────────
     "We know what requirement we are investigating" — not "everything is
     confirmed". */

  test("Requirement Captured refuses a missing product, quantity or certainty", async () => {
    const base = { requirementItems: [{ product: "Housekeeping shirts", quantity: 500 }], requirementCertainty: "suspected" };

    const noProduct = await createLead({ requirementCertainty: "suspected", estimatedQuantity: 500 });
    const r1 = await setState(noProduct._id, { qualificationState: "qualified" });
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/product/i);

    const noQty = await createLead({ requirementItems: [{ product: "Shirts" }], requirementCertainty: "suspected" });
    const r2 = await setState(noQty._id, { qualificationState: "qualified" });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toMatch(/quantity/i);

    // zero is not a quantity
    const zeroQty = await createLead({ requirementItems: [{ product: "Shirts", quantity: 0 }], requirementCertainty: "suspected" });
    expect((await setState(zeroQty._id, { qualificationState: "qualified" })).status).toBe(400);

    const unknown = await createLead(base);
    await call(`/${unknown._id}`, { method: "PATCH", body: { requirementCertainty: "unknown" } });
    const r3 = await setState(unknown._id, { qualificationState: "qualified" });
    expect(r3.status).toBe(400);
    expect(r3.body.message).toMatch(/unknown/i);
  });

  test("a SUSPECTED requirement is enough to identify it", async () => {
    /* The stage means we know what we are investigating. Demanding confirmation
       here would leave nothing for Enquiry Ready to ask. */
    const lead = await createLead({
      requirementItems: [{ product: "Housekeeping shirts", quantity: 500 }],
      requirementCertainty: "suspected",
    });
    const r = await setState(lead._id, { qualificationState: "qualified" });
    expect(r.status).toBe(200);
    expect(r.body.lead.qualificationState).toBe("qualified");
  });

  test("Requirement Captured does NOT ask for annual figures, budget or a delivery date", async () => {
    const lead = await createLead({
      requirementItems: [{ product: "Housekeeping shirts", quantity: 500 }],
      requirementCertainty: "suspected",
      // deliberately: no estimatedAnnualQuantity/Revenue, no budget, no requirementDate,
      // no decision-maker, no email — none of it is this stage's business
    });
    expect((await setState(lead._id, { qualificationState: "qualified" })).status).toBe(200);
  });

  /* ── READY FOR ENQUIRY ──────────────────────────────────────────────────
     Everything above, plus what an Enquiry cannot be raised without. */

  const identified = async (over = {}) => {
    const lead = await createLead({ ...QUALIFICATION_READY_FIELDS, ...over });
    await setState(lead._id, { qualificationState: "qualified" });
    return lead;
  };

  test("Enquiry Ready refuses a merely SUSPECTED requirement", async () => {
    const lead = await identified({ requirementCertainty: "suspected" });
    const r = await setState(lead._id, { qualificationState: "readyToConvert" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/confirmed by the customer or a document/i);

    await call(`/${lead._id}`, { method: "PATCH", body: { requirementCertainty: "prospect_confirmed" } });
    expect((await setState(lead._id, { qualificationState: "readyToConvert" })).status).toBe(200);
  });

  test("Enquiry Ready requires a decision-maker and a contact route", async () => {
    const noDM = await identified();
    await call(`/${noDM._id}`, { method: "PATCH", body: { decisionMakerName: "" } });
    const r1 = await setState(noDM._id, { qualificationState: "readyToConvert" });
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/decision-maker/i);

    const noContact = await identified();
    await call(`/${noContact._id}`, { method: "PATCH", body: { phone: "", email: "", whatsapp: "" } });
    const r2 = await setState(noContact._id, { qualificationState: "readyToConvert" });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toMatch(/contact route/i);
  });

  test("Enquiry Ready still needs the requirement itself", async () => {
    const lead = await identified();
    await call(`/${lead._id}`, { method: "PATCH", body: { productInterest: [], requirementItems: [] } });
    const r = await setState(lead._id, { qualificationState: "readyToConvert" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/named product|product/i);
  });

  test("optional commercial estimates are not required at any stage", async () => {
    /* A Lead that must forecast a year of business before it can raise an
       Enquiry is a Lead nobody moves. */
    const lead = await identified();
    const before = await Lead.findById(lead._id).lean();
    expect(before.estimatedAnnualQuantity).toBeUndefined();
    expect(before.estimatedAnnualRevenue).toBeUndefined();
    expect((await setState(lead._id, { qualificationState: "readyToConvert" })).status).toBe(200);
  });

  test("but an estimate PRESENTED as researched must carry its own source", async () => {
    /* An unevidenced "researched" figure is indistinguishable from a guess,
       which is the entire problem. */
    const lead = await identified();
    await call(`/${lead._id}`, { method: "PATCH", body: {
      estimatedAnnualQuantity: 12000,
      estimatedAnnualQuantityConfidence: "researched",
    } });
    const r = await setState(lead._id, { qualificationState: "readyToConvert" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/source/i);

    await call(`/${lead._id}`, { method: "PATCH", body: { estimatedAnnualQuantitySource: "Their 2025 tender document" } });
    expect((await setState(lead._id, { qualificationState: "readyToConvert" })).status).toBe(200);
  });

  test("an ASSUMED estimate needs nothing", async () => {
    const lead = await identified();
    await call(`/${lead._id}`, { method: "PATCH", body: {
      estimatedAnnualRevenue: 900000,
      estimatedAnnualRevenueConfidence: "assumed",
    } });
    expect((await setState(lead._id, { qualificationState: "readyToConvert" })).status).toBe(200);
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

  test("a researched estimate is enforced at the ENQUIRY gate, not while identifying the requirement", async () => {
    /* This used to fire at Qualified. Identifying what a customer is asking
       about must not depend on evidencing a year's forecast — the evidence
       rule belongs where the estimate is actually relied on. */
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await call(`/${lead._id}`, { method: "PATCH", body: { estimatedAnnualQuantity: 10000, estimatedAnnualQuantityConfidence: "researched" } });

    // Requirement Captured is unaffected by the unevidenced figure.
    const identified = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "qualified" } });
    expect(identified.status).toBe(200);

    const refused = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "readyToConvert" } });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/source/i);

    // The source is attached INLINE to the number — no separate evidence record.
    await call(`/${lead._id}`, { method: "PATCH", body: { estimatedAnnualQuantitySource: "https://example.com/report" } });
    const ok = await call(`/${lead._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "readyToConvert" } });
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
