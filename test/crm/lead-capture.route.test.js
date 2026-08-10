// test/crm/lead-capture.route.test.js
//
// Lead Capture chunk (Lead Capture & Duplicate Prevention) — HTTP-level tests
// for the additions to POST /api/cms/crm/leads and the new
// POST /api/cms/crm/leads/duplicate-check. Mirrors lead.route.test.js's
// harness (bare Express app, mocked SalesAuthMiddlewear + changeLog, real
// Mongoose against the in-memory Mongo from test/setup.js) rather than
// re-mounting the whole suite, so this file stays focused on what actually
// changed: the relaxed firstName rule, sourcedBy defaulting, atomic
// first-follow-up creation, and the duplicate-check endpoint.
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
const SalesDepartment = require("../../models/SalesDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };
// MANAGER needs a real "approver" DepartmentRole row (seeded below) — the
// Lead correction chunk's authorizeOwnerSourceChange now genuinely checks
// isSalesManager before letting a caller set assignedTo/sourcedBy to anyone
// other than themselves, so this fixture must actually satisfy that check.
const MANAGER = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Menon", role: "sales", email: "priya.manager@example.com" };

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
  await DepartmentRole.create({ departmentSlug: "sales", email: MANAGER.email, name: MANAGER.name, role: "approver" });
  // Real SalesDepartment rows (Lead correction chunk: assignedToName/
  // sourcedByName are now always resolved server-side from this collection,
  // never trusted from the client — see resolveEmployeeName in leads.js).
  await SalesDepartment.deleteMany({});
  await SalesDepartment.create([
    { _id: SALES_USER.id, email: "anita@example.com", password: "x", name: SALES_USER.name, employeeId: "EMP-SU-1", phone: "9000000001" },
    { _id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, employeeId: "EMP-MG-1", phone: "9000000002" },
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

/* ── Prospect rule: company OR first name ────────────────────────────────── */

describe("POST /leads — company-or-first-name capture rule", () => {
  test("a company-only prospect (no firstName) is accepted", async () => {
    const { status, body } = await call("/", {
      method: "POST",
      body: { prospectType: "company", company: "ABC Textiles" },
    });
    expect(status).toBe(201);
    expect(body.lead.company).toBe("ABC Textiles");
    expect(body.lead.firstName).toBeFalsy();
  });

  test("a first-name-only prospect (no company) is still accepted", async () => {
    const { status, body } = await call("/", {
      method: "POST",
      body: { prospectType: "individual", firstName: "Ravi" },
    });
    expect(status).toBe(201);
    expect(body.lead.firstName).toBe("Ravi");
  });

  test("neither company nor firstName is rejected with a clear message, nothing persisted", async () => {
    const { status, body } = await call("/", { method: "POST", body: { phone: "9876543210" } });
    expect(status).toBe(400);
    expect(body.message).toMatch(/company name or a first name/i);
    expect(await Lead.countDocuments()).toBe(0);
  });

  test("the same rule is enforced at the model layer on a later PATCH that blanks both", async () => {
    const created = await call("/", { method: "POST", body: { company: "Only Co" } });
    const { status, body } = await call(`/${created.body.lead._id}`, {
      method: "PATCH",
      body: { company: "" },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/company name or a first name/i);
  });
});

/* ── Sourced by vs owner vs created by ───────────────────────────────────── */

describe("POST /leads — sourcedBy / assignedTo separation", () => {
  test("an ordinary salesperson gets both sourcedBy and assignedTo defaulted to themselves", async () => {
    const { body } = await call("/", { method: "POST", body: { firstName: "Kiran" } });
    expect(body.lead.sourcedBy).toBe(SALES_USER.id);
    expect(body.lead.sourcedByName).toBe(SALES_USER.name);
    expect(body.lead.assignedTo).toBe(SALES_USER.id);
    expect(body.lead.assignedToName).toBe(SALES_USER.name);
  });

  test("a manager can explicitly leave a Lead unassigned by sending assignedTo: \"\" — an omitted key still defaults to the creator", async () => {
    const omitted = await call("/", { method: "POST", body: { firstName: "Defaulted" }, user: MANAGER });
    expect(omitted.body.lead.assignedTo).toBe(MANAGER.id);

    const explicit = await call("/", {
      method: "POST",
      body: { firstName: "Inbound", assignedTo: "" },
      user: MANAGER,
    });
    expect(explicit.status).toBe(201);
    expect(explicit.body.lead.assignedTo).toBeFalsy();
    expect(explicit.body.lead.assignedToName).toBeFalsy();
    // sourcedBy is unaffected by the unassign choice — still defaults to the creator.
    expect(explicit.body.lead.sourcedByName).toBe(MANAGER.name);
  });

  test("an unassigned Lead's first-action task still gets an owner — the creator, not nobody", async () => {
    const { body } = await call("/", {
      method: "POST",
      body: {
        firstName: "Inbound",
        assignedTo: "",
        firstAction: { subject: "Log the enquiry", dueDate: "2026-09-12T09:00:00.000Z" },
      },
      user: MANAGER,
    });
    const stored = await Activity.findOne({ leadId: body.lead._id }).lean();
    expect(stored.ownerId.toString()).toBe(MANAGER.id);
  });

  test("a manager can set sourcedBy and assignedTo independently (inbound lead captured on someone else's behalf)", async () => {
    const { status, body } = await call("/", {
      method: "POST",
      body: {
        firstName: "Deepak",
        sourcedBy: SALES_USER.id,
        sourcedByName: SALES_USER.name,
        assignedTo: MANAGER.id,
        assignedToName: MANAGER.name,
      },
      user: MANAGER,
    });
    expect(status).toBe(201);
    expect(body.lead.sourcedByName).toBe(SALES_USER.name);
    expect(body.lead.assignedToName).toBe(MANAGER.name);
    // createdBy is always the actual API caller, regardless of sourcedBy/assignedTo.
    expect(body.lead.createdBy.name).toBe(MANAGER.name);
  });
});

/* ── First action: atomic Lead + first CRMActivity ───────────────────────── */

describe("POST /leads — firstAction creates the Lead's first follow-up atomically", () => {
  test("with a valid firstAction, both the Lead and a planned follow_up Activity are created, and nextFollowUpAt is set", async () => {
    const dueDate = "2026-09-10T09:30:00.000Z";
    const { status, body } = await call("/", {
      method: "POST",
      body: {
        firstName: "Meera",
        firstAction: { subject: "Call to introduce", dueDate, notes: "Ask for procurement contact" },
      },
    });
    expect(status).toBe(201);
    expect(body.lead.nextFollowUpAt).toBeTruthy();
    expect(new Date(body.lead.nextFollowUpAt).toISOString()).toBe(dueDate);

    expect(body.activity).toBeTruthy();
    expect(body.activity.activityType).toBe("follow_up");
    expect(body.activity.subject).toBe("Call to introduce");
    expect(body.activity.status).toBe("planned");
    expect(body.activity.leadId).toBe(body.lead._id);
    expect(new Date(body.activity.dueDate).toISOString()).toBe(dueDate);

    const stored = await Activity.findOne({ leadId: body.lead._id }).lean();
    expect(stored).toBeTruthy();
    expect(stored.ownerId.toString()).toBe(SALES_USER.id);
  });

  test("without firstAction, no Activity is created and the Lead has no nextFollowUpAt — behaviour unchanged for callers who omit it", async () => {
    const { status, body } = await call("/", { method: "POST", body: { firstName: "NoFollowUp" } });
    expect(status).toBe(201);
    expect(body.activity).toBeNull();
    expect(body.lead.nextFollowUpAt).toBeFalsy();
    expect(await Activity.countDocuments({ leadId: body.lead._id })).toBe(0);
  });

  test("firstAction without a subject is rejected before the Lead is created", async () => {
    const { status, body } = await call("/", {
      method: "POST",
      body: { firstName: "Bad", firstAction: { dueDate: "2026-09-10T09:30:00.000Z" } },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/next/i);
    expect(await Lead.countDocuments()).toBe(0);
  });

  test("firstAction without a dueDate is rejected before the Lead is created", async () => {
    const { status, body } = await call("/", {
      method: "POST",
      body: { firstName: "Bad", firstAction: { subject: "Call" } },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/follow-up date/i);
    expect(await Lead.countDocuments()).toBe(0);
  });

  test("the follow-up task's owner is the Lead's assignedTo, not necessarily the creator", async () => {
    // Assigning to someone other than the caller is a manager-only move
    // (Lead correction chunk's authorizeOwnerSourceChange) — SALES_USER
    // captures this on the caller's own behalf being handed to MANAGER, so
    // the request itself must come from a manager, per that rule.
    const { body } = await call("/", {
      method: "POST",
      body: {
        firstName: "Handoff",
        assignedTo: MANAGER.id,
        firstAction: { subject: "First call", dueDate: "2026-09-11T10:00:00.000Z" },
      },
      user: MANAGER,
    });
    const stored = await Activity.findOne({ leadId: body.lead._id }).lean();
    expect(stored.ownerId.toString()).toBe(MANAGER.id);
    expect(stored.ownerName).toBe(MANAGER.name);
  });
});

/* ── Duplicate check ──────────────────────────────────────────────────────── */

describe("POST /leads/duplicate-check", () => {
  test("matches an existing Lead by exact phone", async () => {
    await call("/", { method: "POST", body: { firstName: "Existing", phone: "+91 98765 43210" } });
    const { status, body } = await call("/duplicate-check", {
      method: "POST",
      body: { phone: "9876543210" },
    });
    expect(status).toBe(200);
    expect(body.hasMatches).toBe(true);
    expect(body.leadMatches.length).toBe(1);
    expect(body.leadMatches[0].matchedOn).toContain("phone");
    expect(body.leadMatches[0].confidence).toBe("high");
  });

  test("matches an existing Lead by exact email", async () => {
    await call("/", { method: "POST", body: { firstName: "Existing", email: "buyer@abc.com" } });
    const { body } = await call("/duplicate-check", { method: "POST", body: { email: "buyer@abc.com" } });
    expect(body.leadMatches[0].matchedOn).toContain("email");
  });

  test("matches an existing Lead by company name, case-insensitively", async () => {
    // Lead.normalizeCompany is a plain trim+lowercase (see Lead.js's own
    // pre-save hook) — not the fuzzier punctuation/whitespace-collapsing
    // normalizeName used for Accounts, so the match here is exact modulo
    // case, not "ABC Textiles Ltd." vs "abc textiles ltd" fuzzy equivalence.
    await call("/", { method: "POST", body: { company: "Zenith Apparel Co" } });
    const { body } = await call("/duplicate-check", { method: "POST", body: { company: "zenith apparel co" } });
    expect(body.leadMatches.length).toBe(1);
    expect(body.leadMatches[0].matchedOn).toContain("company");
  });

  test("matches an existing Account by company name / website / phone", async () => {
    await Account.create({ companyName: "Zenith Uniforms", website: "https://zenithuniforms.com", primaryPhone: "9123456789" });
    const { body } = await call("/duplicate-check", { method: "POST", body: { website: "zenithuniforms.com" } });
    expect(body.accountMatches.length).toBe(1);
    expect(body.accountMatches[0].companyName).toBe("Zenith Uniforms");
    expect(body.hasMatches).toBe(true);
  });

  test("no signal at all (blank form) returns no matches rather than scanning everything", async () => {
    await call("/", { method: "POST", body: { firstName: "Someone", company: "Some Co" } });
    const { status, body } = await call("/duplicate-check", { method: "POST", body: {} });
    expect(status).toBe(200);
    expect(body.hasMatches).toBe(false);
    expect(body.leadMatches).toEqual([]);
    expect(body.accountMatches).toEqual([]);
  });

  test("a genuinely different prospect returns no matches", async () => {
    await call("/", { method: "POST", body: { firstName: "Existing", company: "ABC Textiles", phone: "9876543210" } });
    const { body } = await call("/duplicate-check", {
      method: "POST",
      body: { company: "Totally Different Co", phone: "9111111111", email: "new@other.com" },
    });
    expect(body.hasMatches).toBe(false);
  });

  test("excludeId omits the Lead being edited from its own duplicate check", async () => {
    const created = await call("/", { method: "POST", body: { firstName: "Self", phone: "9000000000" } });
    const { body } = await call("/duplicate-check", {
      method: "POST",
      body: { phone: "9000000000", excludeId: created.body.lead._id },
    });
    expect(body.leadMatches).toEqual([]);
  });

  test("does not create, update or archive any record — read-only", async () => {
    await call("/", { method: "POST", body: { firstName: "Existing", phone: "9876543210" } });
    const before = await Lead.countDocuments();
    await call("/duplicate-check", { method: "POST", body: { phone: "9876543210" } });
    expect(await Lead.countDocuments()).toBe(before);
  });
});
