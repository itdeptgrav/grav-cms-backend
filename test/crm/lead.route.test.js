// test/crm/lead.route.test.js
//
// HTTP-level tests for /api/cms/crm/leads (Lead Chunk 1, revised after
// review). Mirrors test/crm/sales-journey.route.test.js: the router is
// mounted on a bare Express app and driven with global fetch,
// SalesAuthMiddlewear and recordChange are mocked so identity and audit
// calls are assertable without a JWT or a real ChangeLog write.
//
// Role + approval enforcement (departmentWriteGuard / salesWrites("lead")) is
// mount-level infrastructure in server.js, unmodified by this chunk, and — as
// with sales-journey.route.test.js — is not re-exercised here; only
// SalesAuthMiddlewear's identity check (401 without a user) is covered at
// this layer.
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
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

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
  recordChange.mockClear();
  await _resetSequence(new Date().getFullYear());
});

/** One request, as a given user. */
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

async function createLead(over = {}) {
  const { body } = await call("/", { method: "POST", body: validBody(over) });
  return body.lead;
}

// The full computeQualificationReadiness checklist (services/leadReadiness.js)
// — needed on any Lead this file moves to "qualified"/"readyToConvert", now
// that both are gated on it rather than the bare transition graph.
const QUALIFICATION_READY_FIELDS = {
  phone: "9876500000",
  productInterest: ["Shirts"],
  estimatedQuantity: 500,
  requirementDate: "2026-12-01T00:00:00.000Z",
  requirementCertainty: "prospect_confirmed",
  decisionMakerName: "Ravi Kumar",
};

// "Contacted" now requires a real, logged SUCCESSFUL two-way contact
// (services/leadQualification.js's context.hasSuccessfulContact) — this logs
// one directly against the shared CRMActivity model, the same way a real
// caller would via POST /:id/activities before attempting the move.
async function logSuccessfulContact(leadId) {
  await Activity.create({
    leadId,
    activityType: "call",
    subject: "Intro call",
    status: "completed",
    completedAt: new Date(),
    outcome: "replied_connected",
    ownerId: SALES_USER.id,
    ownerName: SALES_USER.name,
  });
}

/* ── Auth ─────────────────────────────────────────────────────────────────── */

describe("authentication", () => {
  test("POST / without a session is refused", async () => {
    const { status } = await call("/", { method: "POST", body: validBody(), user: null });
    expect(status).toBe(401);
  });
});

/* ── GET / — scope + qualificationState (Lead Chunk 2: Lead Inbox) ──────── */

describe("GET /leads — scope and qualificationState filters", () => {
  test("scope=mine server-resolves to the caller's own id, ignoring a client-supplied assignedTo", async () => {
    const other = { id: new mongoose.Types.ObjectId().toString(), name: "Someone Else", role: "sales" };
    await call("/", { method: "POST", body: validBody({ firstName: "Mine" }) }); // assigned to SALES_USER by default
    await call("/", { method: "POST", body: validBody({ firstName: "Theirs" }), user: other });

    const { body } = await call(`/?scope=mine&assignedTo=${other.id}`);
    expect(body.leads.map((l) => l.firstName)).toEqual(["Mine"]);
  });

  test("qualificationState=active excludes disqualified/duplicate; a specific code matches exactly", async () => {
    const lead = await createLead({ firstName: "ToDisqualify" });
    await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "disqualified", reason: "No budget" },
    });
    await createLead({ firstName: "StillNew" });

    const active = await call("/?qualificationState=active");
    expect(active.body.leads.map((l) => l.firstName).sort()).toEqual(["StillNew"]);

    const disqualified = await call("/?qualificationState=disqualified");
    expect(disqualified.body.leads.map((l) => l.firstName)).toEqual(["ToDisqualify"]);

    const all = await call("/?qualificationState=all");
    expect(all.body.leads.length).toBe(2);
  });

  test("qualificationState=active also excludes Nurture — it has its own view now", async () => {
    const lead = await createLead({ firstName: "ToNurture" });
    await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "nurture", reason: "Budget freeze", nextAction: { subject: "Check back", dueDate: new Date(Date.now() + 30 * 86400000).toISOString() } },
    });
    await createLead({ firstName: "StillActive" });

    const active = await call("/?qualificationState=active");
    expect(active.body.leads.map((l) => l.firstName)).toEqual(["StillActive"]);

    const nurture = await call("/?qualificationState=nurture");
    expect(nurture.body.leads.map((l) => l.firstName)).toEqual(["ToNurture"]);
  });

  test("qualificationState=history returns exactly the three terminal outcomes, and links a Converted row to its Journey", async () => {
    const disqualified = await createLead({ firstName: "Disqualified" });
    await call(`/${disqualified._id}/qualification-state`, { method: "PATCH", body: { qualificationState: "disqualified", reason: "No fit" } });

    const other = await createLead({ firstName: "Original" });
    const duplicate = await createLead({ firstName: "Duplicate" });
    await call(`/${duplicate._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "duplicate", reason: "Same buyer", duplicateOf: { type: "lead", id: other._id } },
    });

    // A Converted Lead isn't reachable through this router (that's the
    // sales-journeys bridge's job — see sales-journey.route.test.js); set it
    // directly so THIS test stays focused on the list/populate behaviour.
    const journey = await SalesJourney.create({
      journeyId: "SJ-2026-8001", name: "Converted Buyer Co", accountId: new mongoose.Types.ObjectId(),
      businessType: "directBrand", ownerId: new mongoose.Types.ObjectId(),
    });
    const converted = await createLead({ firstName: "Converted" });
    await Lead.updateOne({ _id: converted._id }, { $set: { qualificationState: "converted", conversion: { journeyId: journey._id, convertedAt: new Date() } } });

    await createLead({ firstName: "StillActive" });

    const { body } = await call("/?qualificationState=history");
    expect(body.leads.map((l) => l.firstName).sort()).toEqual(["Converted", "Disqualified", "Duplicate"]);

    const convertedRow = body.leads.find((l) => l.firstName === "Converted");
    expect(convertedRow.conversion.journeyId.journeyId).toBe("SJ-2026-8001");
    expect(convertedRow.conversion.journeyId.name).toBe("Converted Buyer Co");

    const duplicateRow = body.leads.find((l) => l.firstName === "Duplicate");
    expect(String(duplicateRow.duplicateOf.id)).toBe(String(other._id));
  });
});

/* ── Create — reference + audit + whitelist ──────────────────────────────── */

describe("POST /leads", () => {
  test("creates a Lead with a server-assigned LEAD-YYYY-NNNN reference and audits it", async () => {
    const { status, body } = await call("/", { method: "POST", body: validBody() });
    expect(status).toBe(201);
    expect(body.lead.leadId).toMatch(/^LEAD-\d{4}-\d{4}$/);
    expect(body.lead.qualificationState).toBe("new");
    expect(recordChange).toHaveBeenCalledTimes(1);
    expect(recordChange.mock.calls[0][1]).toMatchObject({ entity: "lead", action: "create" });
  });

  test("server-assigns createdBy/updatedBy regardless of body", async () => {
    const { body } = await call("/", {
      method: "POST",
      body: validBody({ createdBy: { id: "x", name: "Someone Else" } }),
    });
    expect(body.lead.createdBy.name).toBe(SALES_USER.name);
  });

  test("the client-editable whitelist blocks system/conversion fields on create", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const { status, body } = await call("/", {
      method: "POST",
      body: validBody({
        leadId: "LEAD-1999-9999",
        qualificationState: "converted",
        isActive: false,
        conversion: { accountId: fakeId },
        convertedToCustomer: true,
      }),
    });
    expect(status).toBe(201);
    expect(body.lead.leadId).not.toBe("LEAD-1999-9999");
    expect(body.lead.qualificationState).toBe("new"); // schema default, not "converted"
    expect(body.lead.isActive).toBe(true);
    expect(body.lead.convertedToCustomer).toBe(false);
    // Mongoose's default `minimize` strips an all-empty nested object from the
    // JSON response entirely, so `conversion` itself may be absent — either
    // way, no accountId leaked through.
    expect(body.lead.conversion?.accountId).toBeUndefined();
  });

  test("`stage` passes through create and keeps qualificationState in sync — the grav-cms Add Lead modal relies on this", async () => {
    const { status, body } = await call("/", { method: "POST", body: validBody({ stage: "qualified" }) });
    expect(status).toBe(201);
    expect(body.lead.stage).toBe("qualified");
    expect(body.lead.qualificationState).toBe("qualified"); // derived, not independent
  });

  test("create rejects proposal_sent/negotiation/won outright — nothing is partially created", async () => {
    for (const stage of ["proposal_sent", "negotiation", "won"]) {
      const { status, body } = await call("/", { method: "POST", body: validBody({ stage }) });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
    }
    expect(await Lead.countDocuments()).toBe(0);
  });

  test("create maps legacy 'lost' to canonical disqualified, requiring a reason", async () => {
    const noReason = await call("/", { method: "POST", body: validBody({ stage: "lost" }) });
    expect(noReason.status).toBe(400);
    expect(await Lead.countDocuments()).toBe(0);

    const withReason = await call("/", { method: "POST", body: validBody({ stage: "lost", reason: "Not a fit" }) });
    expect(withReason.status).toBe(201);
    expect(withReason.body.lead.stage).toBe("lost");
    expect(withReason.body.lead.qualificationState).toBe("disqualified");
    expect(withReason.body.lead.qualificationReason).toBe("Not a fit");
  });
});

/* ── Update — whitelist + legacy stage compatibility ─────────────────────── */

describe("PATCH /leads/:id", () => {
  test("updates a whitelisted business field and audits before/after", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}`, {
      method: "PATCH",
      body: { notes: "Called, interested in uniforms" },
    });
    expect(status).toBe(200);
    expect(body.lead.notes).toBe("Called, interested in uniforms");
    expect(recordChange).toHaveBeenCalledTimes(2); // create + update
    expect(recordChange.mock.calls[1][1]).toMatchObject({ entity: "lead", action: "update" });
  });

  test("converted cannot be faked through a generic patch", async () => {
    const lead = await createLead();
    const { body } = await call(`/${lead._id}`, {
      method: "PATCH",
      body: { qualificationState: "converted" },
    });
    expect(body.lead.qualificationState).toBe("new");
  });

  test("an unchanged stage resubmission is safely ignored (no-op)", async () => {
    const lead = await createLead(); // stage "new"
    const before = recordChange.mock.calls.length;
    const { status, body } = await call(`/${lead._id}`, {
      method: "PATCH",
      body: { stage: "new", notes: "unchanged stage, different field" },
    });
    expect(status).toBe(200);
    expect(body.lead.stage).toBe("new");
    expect(body.lead.notes).toBe("unchanged stage, different field");
    // Still only one recordChange call for this update (the ordinary field
    // edit) — the unchanged stage did not trigger a second transition audit.
    expect(recordChange.mock.calls.length).toBe(before + 1);
  });

  test("a real stage change is routed through the shared transition service, keeping both fields in sync", async () => {
    const lead = await createLead();
    await logSuccessfulContact(lead._id);
    const { status, body } = await call(`/${lead._id}`, {
      method: "PATCH",
      body: { stage: "contacted" },
    });
    expect(status).toBe(200);
    expect(body.lead.stage).toBe("contacted");
    expect(body.lead.qualificationState).toBe("contacted");
  });

  test("proposal_sent/negotiation/won can no longer be assigned via the generic update, and no side effects leak through", async () => {
    const lead = await createLead();
    for (const stage of ["proposal_sent", "negotiation", "won"]) {
      const { status } = await call(`/${lead._id}`, { method: "PATCH", body: { stage } });
      expect(status).toBe(400);
    }
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.stage).toBe("new");
    expect(stored.probability).toBe(20);
    expect(stored.convertedToCustomer).toBe(false);
  });

  test("an invalid transition is rejected even via the generic update (new -> qualified skips the funnel)", async () => {
    const lead = await createLead(); // qualificationState "new"
    const { status } = await call(`/${lead._id}`, { method: "PATCH", body: { stage: "qualified" } });
    expect(status).toBe(400);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.qualificationState).toBe("new");
  });

  test("legacy 'lost' maps to canonical disqualified and requires a reason", async () => {
    const lead = await createLead();
    const noReason = await call(`/${lead._id}`, { method: "PATCH", body: { stage: "lost" } });
    expect(noReason.status).toBe(400);

    const withReason = await call(`/${lead._id}`, { method: "PATCH", body: { stage: "lost", reason: "Went cold" } });
    expect(withReason.status).toBe(200);
    expect(withReason.body.lead.stage).toBe("lost");
    expect(withReason.body.lead.qualificationState).toBe("disqualified");
  });
});

/* ── Contacts — the multi-stakeholder list (Chunk B) ─────────────────────── */

describe("PATCH /leads/:id — contacts", () => {
  test("saves a contacts list, sanitising shape and dropping nameless entries", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}`, {
      method: "PATCH",
      body: {
        contacts: [
          { name: "  Ravi Kumar ", role: "Head Merchandiser", email: "RAVI@EXAMPLE.COM", phone: "9876500000", isDecisionMaker: true, injected: "ignored" },
          { name: "", role: "should be dropped" },
          { role: "no name either" },
        ],
      },
    });
    expect(status).toBe(200);
    expect(body.lead.contacts).toHaveLength(1);
    expect(body.lead.contacts[0]).toMatchObject({
      name: "Ravi Kumar", role: "Head Merchandiser", email: "ravi@example.com", phone: "9876500000", isDecisionMaker: true,
    });
    expect(body.lead.contacts[0].injected).toBeUndefined();
    expect(body.lead.contacts[0]._id).toBeTruthy(); // server-assigned
  });

  test("replaces the whole list on save, and an empty list clears it", async () => {
    const lead = await createLead();
    await call(`/${lead._id}`, { method: "PATCH", body: { contacts: [{ name: "A" }, { name: "B" }] } });
    const two = await call(`/${lead._id}`);
    expect(two.body.lead.contacts).toHaveLength(2);

    const cleared = await call(`/${lead._id}`, { method: "PATCH", body: { contacts: [] } });
    expect(cleared.body.lead.contacts).toHaveLength(0);
  });

  test("a contact flagged as the decision-maker satisfies the qualification check", async () => {
    // A ready-ish Lead missing only the decision-maker.
    const lead = await createLead({
      phone: "9876500000", productInterest: ["Shirts"], estimatedQuantity: 500,
      requirementDate: "2026-12-01T00:00:00.000Z", requirementCertainty: "prospect_confirmed",
    });
    const before = await call(`/${lead._id}/readiness`);
    expect(before.body.qualification.checks.find((c) => c.key === "decisionMaker").met).toBe(false);

    await call(`/${lead._id}`, { method: "PATCH", body: { contacts: [{ name: "Priya Menon", role: "Buyer", isDecisionMaker: true }] } });

    const after = await call(`/${lead._id}/readiness`);
    expect(after.body.qualification.checks.find((c) => c.key === "decisionMaker").met).toBe(true);
  });
});

/* ── Canonical qualification-state transitions ───────────────────────────── */

describe("PATCH /leads/:id/qualification-state", () => {
  test("moves through the canonical vocabulary and audits it", async () => {
    const lead = await createLead();
    await logSuccessfulContact(lead._id);
    const { status, body } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "contacted" },
    });
    expect(status).toBe(200);
    expect(body.lead.qualificationState).toBe("contacted");
    expect(recordChange.mock.calls.at(-1)[1]).toMatchObject({ entity: "lead", action: "update" });
  });

  test("rejects a legacy stage name — it is not in the canonical enum", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "proposal_sent" },
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test("always rejects 'converted' — reserved for the Chunk 5 conversion service", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "converted" },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/conversion service/i);
  });

  test("requires a reason for disqualified", async () => {
    const lead = await createLead();
    const noReason = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "disqualified" },
    });
    expect(noReason.status).toBe(400);

    const withReason = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "disqualified", reason: "Budget too small" },
    });
    expect(withReason.status).toBe(200);
    expect(withReason.body.lead.qualificationReason).toBe("Budget too small");
  });

  test("requires a reason for duplicate", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}/qualification-state`, {
      method: "PATCH",
      body: { qualificationState: "duplicate" },
    });
    expect(status).toBe(400);
  });
});

/* ── Explicit transition map (review item 2) ─────────────────────────────── */

describe("canonical transition map — the exact graph from the review", () => {
  async function moveTo(leadId, qualificationState, reason, extra) {
    return call(`/${leadId}/qualification-state`, { method: "PATCH", body: { qualificationState, reason, ...extra } });
  }
  const NEXT_ACTION = { subject: "Call back", dueDate: "2026-10-01T09:00:00.000Z" };

  test("new -> qualified directly is rejected (must pass through contacted)", async () => {
    const lead = await createLead();
    expect((await moveTo(lead._id, "qualified")).status).toBe(400);
  });

  test("the happy path: new -> contacted -> qualified -> readyToConvert", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await logSuccessfulContact(lead._id);
    expect((await moveTo(lead._id, "contacted")).status).toBe(200);
    expect((await moveTo(lead._id, "qualified")).status).toBe(200);
    expect((await moveTo(lead._id, "readyToConvert")).status).toBe(200);
  });

  test("readyToConvert cannot go backward to qualified or contacted", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await logSuccessfulContact(lead._id);
    await moveTo(lead._id, "contacted");
    await moveTo(lead._id, "qualified");
    await moveTo(lead._id, "readyToConvert");
    expect((await moveTo(lead._id, "qualified")).status).toBe(400);
    expect((await moveTo(lead._id, "contacted")).status).toBe(400);
  });

  test("nurture can return to contacted or qualified", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await logSuccessfulContact(lead._id);
    await moveTo(lead._id, "contacted");
    expect((await moveTo(lead._id, "nurture", "Busy this month", { nextAction: NEXT_ACTION })).status).toBe(200);
    expect((await moveTo(lead._id, "qualified")).status).toBe(200);
  });

  test("every state (except terminal ones) can move to disqualified or duplicate with a reason", async () => {
    const lead = await createLead();
    expect((await moveTo(lead._id, "disqualified", "No budget")).status).toBe(200);
  });

  test("disqualified is terminal — no further transition, not even re-entering itself", async () => {
    const lead = await createLead();
    expect((await moveTo(lead._id, "disqualified", "No budget")).status).toBe(200);
    expect((await moveTo(lead._id, "contacted")).status).toBe(400);
    expect((await moveTo(lead._id, "disqualified", "Again")).status).toBe(400);
  });

  test("duplicate is terminal", async () => {
    const lead = await createLead();
    // Duplicate now requires a GENUINE, verified-to-exist Lead/Account link
    // (services/leadQualification.js) — reference a real second Lead.
    const other = await createLead({ firstName: "Other" });
    expect((await moveTo(lead._id, "duplicate", "Same as this other Lead", { duplicateOf: { type: "lead", id: other._id } })).status).toBe(200);
    expect((await moveTo(lead._id, "nurture")).status).toBe(400);
  });

  test("duplicate is rejected without a genuine link, even with a reason", async () => {
    const lead = await createLead();
    const noLink = await moveTo(lead._id, "duplicate", "Looks like a repeat");
    expect(noLink.status).toBe(400);
    const fakeLink = await moveTo(lead._id, "duplicate", "Looks like a repeat", { duplicateOf: { type: "lead", id: new mongoose.Types.ObjectId().toString() } });
    expect(fakeLink.status).toBe(400);
  });

  test("converted is unreachable from any state", async () => {
    const lead = await createLead(QUALIFICATION_READY_FIELDS);
    await logSuccessfulContact(lead._id);
    await moveTo(lead._id, "contacted");
    const { status } = await moveTo(lead._id, "converted");
    expect(status).toBe(400);
  });
});

/* ── Legacy /:id/stage — now a wrapper over the shared service ──────────── */

describe("PATCH /leads/:id/stage — legacy compatibility wrapper", () => {
  test("still accepts new/contacted/qualified, keeps qualificationState in sync, no embedded activity", async () => {
    const lead = await createLead();
    await logSuccessfulContact(lead._id);
    const { status, body } = await call(`/${lead._id}/stage`, { method: "PATCH", body: { stage: "contacted" } });
    expect(status).toBe(200);
    expect(body.lead.stage).toBe("contacted");
    expect(body.lead.qualificationState).toBe("contacted");
    expect(body.lead.activities.length).toBe(0); // no more embedded writes
  });

  test("an unchanged stage is a no-op — no transition audited", async () => {
    const lead = await createLead();
    const before = recordChange.mock.calls.length;
    const { status } = await call(`/${lead._id}/stage`, { method: "PATCH", body: { stage: "new" } });
    expect(status).toBe(200);
    expect(recordChange.mock.calls.length).toBe(before); // no additional call
  });

  test("rejects won/negotiation/proposal_sent — the 'won means converted' side effect is gone", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}/stage`, { method: "PATCH", body: { stage: "won" } });
    expect(status).toBe(400);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.probability).toBe(20);
    expect(stored.convertedToCustomer).toBe(false);
    expect(stored.convertedAt).toBeFalsy();
    expect(stored.stage).toBe("new");
  });

  test("maps legacy 'lost' to canonical disqualified, requiring a reason, and mirrors it onto legacy lostReason", async () => {
    const lead = await createLead();
    const noReason = await call(`/${lead._id}/stage`, { method: "PATCH", body: { stage: "lost" } });
    expect(noReason.status).toBe(400);

    const { status, body } = await call(`/${lead._id}/stage`, {
      method: "PATCH",
      body: { stage: "lost", lostReason: "Budget cut" },
    });
    expect(status).toBe(200);
    expect(body.lead.qualificationState).toBe("disqualified");
    expect(body.lead.qualificationReason).toBe("Budget cut");
    expect(body.lead.lostReason).toBe("Budget cut");
  });

  test("an invalid transition is rejected via the legacy endpoint too (same shared graph)", async () => {
    const lead = await createLead();
    // new -> qualified is not a valid canonical transition.
    const { status } = await call(`/${lead._id}/stage`, { method: "PATCH", body: { stage: "qualified" } });
    expect(status).toBe(400);
  });
});

describe("POST /leads/:id/activity (singular) — legacy request shape, now writes shared CRMActivity", () => {
  test("creates a CRMActivity instead of appending to the embedded array, with a backward-compatible response", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}/activity`, {
      method: "POST",
      body: { type: "call", title: "Intro call", outcome: "replied_connected" },
    });
    expect(status).toBe(200);
    expect(body.lead).toBeTruthy(); // response shape preserved for existing callers
    expect(body.lead.activities.length).toBe(0); // no more embedded writes
    expect(body.activity).toBeTruthy(); // additive
    expect(body.activity.leadId).toBe(lead._id);
    expect(body.activity.subject).toBe("Intro call");
    expect(body.activity.activityType).toBe("call");
    expect(body.activity.outcome).toBe("replied_connected");
    expect(body.activity.status).toBe("completed");

    const stored = await Activity.findById(body.activity._id).lean();
    expect(stored.leadId.toString()).toBe(lead._id);
  });

  test("existing embedded activities from before this fix remain untouched", async () => {
    const lead = await createLead();
    await Lead.updateOne(
      { _id: lead._id },
      { $push: { activities: { type: "note", title: "Old-style entry", completedAt: new Date() } } },
    );
    await call(`/${lead._id}/activity`, { method: "POST", body: { type: "note", title: "New note" } });
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.activities.length).toBe(1);
    expect(stored.activities[0].title).toBe("Old-style entry");
  });

  test("maps legacy type codes onto the CRMActivity vocabulary, falling back to 'other'", async () => {
    const lead = await createLead();
    const email = await call(`/${lead._id}/activity`, { method: "POST", body: { type: "email", title: "Sent brochure" } });
    expect(email.body.activity.activityType).toBe("email_log");

    const unknown = await call(`/${lead._id}/activity`, { method: "POST", body: { type: "status_change" } });
    expect(unknown.body.activity.activityType).toBe("other");
    expect(unknown.body.activity.subject).toBe("Logged status change"); // no title given
  });

  test("updates lastContactedAt only for a genuinely successful contact outcome", async () => {
    const lead = await createLead();
    const before = recordChange.mock.calls.length;
    // No outcome at all — an attempt, not a proven contact — must NOT move
    // lastContactedAt or audit the Lead, only the Activity.
    await call(`/${lead._id}/activity`, { method: "POST", body: { type: "call", title: "Call" } });
    const afterAttemptOnly = await Lead.findById(lead._id).lean();
    expect(afterAttemptOnly.lastContactedAt).toBeFalsy();
    expect(recordChange.mock.calls.length).toBe(before + 1); // activity create only

    await call(`/${lead._id}/activity`, { method: "POST", body: { type: "call", title: "Call back", outcome: "replied_connected" } });
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.lastContactedAt).toBeTruthy();
    expect(recordChange.mock.calls.length).toBe(before + 3); // + activity create + lead update
  });

  test("rejects an outcome outside the structured vocabulary", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}/activity`, { method: "POST", body: { type: "call", title: "Call", outcome: "Interested" } });
    expect(status).toBe(400);
    expect(body.message).toMatch(/outcome must be one of/i);
  });
});

/* ── Canonical shared-Activity endpoints ─────────────────────────────────── */

describe("GET/POST /leads/:id/activities — shared CRMActivity, not the embedded array", () => {
  test("logs a completed interaction with leadId set, no accountId, and persists outcome + nextActionDate", async () => {
    const lead = await createLead();
    const followUp = "2026-09-01T00:00:00.000Z";
    const { status, body } = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "call", subject: "Discovery call", outcome: "replied_connected", nextActionDate: followUp },
    });
    expect(status).toBe(201);
    expect(body.activity.leadId).toBe(lead._id);
    expect(body.activity.accountId).toBeUndefined();
    expect(body.activity.status).toBe("completed");
    expect(body.activity.outcome).toBe("replied_connected");
    expect(new Date(body.activity.nextActionDate).toISOString()).toBe(followUp);

    const stored = await Activity.findById(body.activity._id).lean();
    expect(stored.leadId.toString()).toBe(lead._id);
    expect(stored.outcome).toBe("replied_connected");
    expect(new Date(stored.nextActionDate).toISOString()).toBe(followUp);

    // lastContactedAt correctness: a successful-outcome interaction updates it.
    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.lastContactedAt).toBeTruthy();
  });

  test("does not update lastContactedAt for a non-successful outcome (e.g. No Answer)", async () => {
    const lead = await createLead();
    await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Tried calling", outcome: "no_answer" } });
    const storedLead = await Lead.findById(lead._id).lean();
    expect(storedLead.lastContactedAt).toBeFalsy();
  });

  test("rejects an outcome outside the structured vocabulary", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "call", subject: "Call", outcome: "Positive" } });
    expect(status).toBe(400);
    expect(body.message).toMatch(/outcome must be one of/i);
  });

  test("a task requires a due date and owner", async () => {
    const lead = await createLead();
    const { status, body } = await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "task", subject: "Send catalogue" },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/due date/i);
  });

  test("does not append to the Lead's legacy embedded activities[]", async () => {
    const lead = await createLead();
    await call(`/${lead._id}/activities`, {
      method: "POST",
      body: { activityType: "note", subject: "Left a voicemail" },
    });
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.activities.length).toBe(0);
  });

  test("lists the Lead's activity timeline newest first", async () => {
    const lead = await createLead();
    await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "note", subject: "First" } });
    await call(`/${lead._id}/activities`, { method: "POST", body: { activityType: "note", subject: "Second" } });
    const { status, body } = await call(`/${lead._id}/activities`);
    expect(status).toBe(200);
    expect(body.activities.map((a) => a.subject)).toEqual(["Second", "First"]);
  });
});

/* ── Archive ──────────────────────────────────────────────────────────────── */

describe("DELETE /leads/:id", () => {
  test("soft-archives with archivedAt/archivedBy and audits it", async () => {
    const lead = await createLead();
    const { status } = await call(`/${lead._id}`, { method: "DELETE" });
    expect(status).toBe(200);
    const stored = await Lead.findById(lead._id).lean();
    expect(stored.isActive).toBe(false);
    expect(stored.archivedAt).toBeTruthy();
    expect(stored.archivedBy.name).toBe(SALES_USER.name);
    expect(recordChange.mock.calls.at(-1)[1]).toMatchObject({ entity: "lead", action: "delete" });
  });
});
