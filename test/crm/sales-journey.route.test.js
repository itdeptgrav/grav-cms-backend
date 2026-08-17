// test/crm/sales-journey.route.test.js
//
// HTTP-level tests for /api/cms/crm/sales-journeys.
//
// No supertest in this repo and no new dependency is allowed for this task, so
// the router is mounted on a bare Express app bound to an ephemeral port and
// driven with Node's global fetch. That exercises the real middleware chain,
// the real JSON serialization and the real status codes — which is the point;
// the model-level rules already have their own suite.
//
// Two things are stubbed, both deliberately:
//   • SalesAuthMiddlewear — identity comes from a test header instead of a JWT,
//     so a test can be an admin, an unauthorized viewer, or two different
//     users, without minting tokens.
//   • recordChange — spied rather than executed, so the audit CALL can be
//     asserted without a ChangeLog write in the assertions' way.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

// Identity comes from `x-test-user`; everything downstream is the real thing.
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
const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const Site = require("../../models/CMS_Models/Sales/Site");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const { SALES_JOURNEY_LINK_MODULE } = require("../../constants/crm");

let leadSeq = 0;
/** A minimal Active Lead, Ready for Journey by default — the only state this
 *  bridge accepts. `leadId` is assigned directly (not through the ref-
 *  generator service) since these are route-level tests of the JOURNEY side
 *  of the bridge; Lead reference allocation has its own suite. */
const readyLead = (over = {}) =>
  Lead.create({
    leadId: `LEAD-2026-90${String(++leadSeq).padStart(2, "0")}`,
    company: "Northstar Buying Services",
    qualificationState: "readyToConvert",
    stage: "qualified",
    ...over,
  });

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };
const OTHER_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Leena George", role: "sales" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Owner", role: "admin" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sales-journeys", require("../../routes/CMS_Routes/Sales/salesJourneys"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sales-journeys`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => recordChange.mockClear());

/** One request, as a given user. */
async function call(path = "", { method = "GET", body, user = OWNER } = {}) {
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

const activeAccount = (over = {}) =>
  Account.create({ companyName: "Test Uniform Client Co", status: "active", ...over });

const validBody = (accountId, over = {}) => ({
  accountId: String(accountId),
  name: "MetroCare Uniform Program — 2026 Refresh",
  businessType: "uniform",
  ...over,
});

/* ── Create ───────────────────────────────────────────────────────────────── */

describe("POST /sales-journeys", () => {
  test("creates a Journey at the Enquiry stage with a server-assigned reference", async () => {
    const acc = await activeAccount();
    const { status, body } = await call("", { method: "POST", body: validBody(acc._id) });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.journey.reference).toMatch(/^SJ-\d{4}-\d{4}$/);
    expect(body.journey.currentStage).toBe("enquiry");
    expect(body.journey.currentStageState).toBe("inProgress");
    expect(body.journey.risk).toBe("onTrack");
    // The customer is RESOLVED from the Account, never copied in by the client.
    expect(body.journey.customer).toEqual({
      id: String(acc._id),
      code: acc.accountId ?? null,
      name: "Test Uniform Client Co",
    });
    expect(body.journey.nextAction).toBeNull();
  });

  test("audits the creation", async () => {
    const acc = await activeAccount();
    await call("", { method: "POST", body: validBody(acc._id) });

    expect(recordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ departmentSlug: "sales", entity: "crm-sales-journey", action: "create" }),
    );
  });

  test("a client cannot choose the reference, the stage, or the audit actor", async () => {
    const acc = await activeAccount();
    const { body } = await call("", {
      method: "POST",
      body: validBody(acc._id, {
        journeyId: "SJ-1900-0001",
        currentStage: "production",
        stageStates: { account: "complete", production: "inProgress" },
        createdBy: { id: OTHER_USER.id, name: "Someone Else" },
        ownerId: OTHER_USER.id,
      }),
    });

    expect(body.journey.reference).not.toBe("SJ-1900-0001");
    expect(body.journey.currentStage).toBe("enquiry");
    expect(body.journey.stageStates.production).toBe("notStarted");

    const saved = await SalesJourney.findOne({ journeyId: body.journey.reference }).lean();
    expect(String(saved.ownerId)).toBe(OWNER.id);          // session, not body
    expect(String(saved.createdBy.id)).toBe(OWNER.id);
  });

  test("creates a linked CRMActivity when a first action is supplied", async () => {
    const acc = await activeAccount();
    const due = new Date(Date.now() + 2 * 86400000).toISOString();
    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { nextAction: { label: "Submit revised costing", dueDate: due } }),
    });

    expect(status).toBe(201);
    expect(body.warning).toBeUndefined();
    expect(body.journey.nextAction.label).toBe("Submit revised costing");

    const activity = await Activity.findOne({ subject: "Submit revised costing" }).lean();
    expect(activity.activityType).toBe("task");
    expect(activity.status).toBe("planned");
    expect(String(activity.accountId)).toBe(String(acc._id));
    expect(String(activity.ownerId)).toBe(OWNER.id);

    // Linked BOTH ways, and the Journey stores only a pointer.
    const journey = await SalesJourney.findOne({ journeyId: body.journey.reference }).lean();
    expect(String(journey.currentNextActionId)).toBe(String(activity._id));
    expect(activity.links).toEqual([
      { module: SALES_JOURNEY_LINK_MODULE, recordId: activity.links[0].recordId },
    ]);
    expect(String(activity.links[0].recordId)).toBe(String(journey._id));
    expect(journey.subject).toBeUndefined();
  });

  test("rejects a missing, unknown or inactive account", async () => {
    expect((await call("", { method: "POST", body: { name: "X", businessType: "uniform" } })).status).toBe(400);

    const unknown = new mongoose.Types.ObjectId();
    expect((await call("", { method: "POST", body: validBody(unknown) })).status).toBe(400);

    const archived = await activeAccount({ companyName: "Archived Co", status: "archived" });
    const res = await call("", { method: "POST", body: validBody(archived._id) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not active/i);
  });

  test("rejects a missing name, a missing business type, and an unknown one", async () => {
    const acc = await activeAccount();
    expect((await call("", { method: "POST", body: validBody(acc._id, { name: "  " }) })).status).toBe(400);
    expect((await call("", { method: "POST", body: validBody(acc._id, { businessType: undefined }) })).status).toBe(400);
    expect((await call("", { method: "POST", body: validBody(acc._id, { businessType: "wholesale" }) })).status).toBe(400);
  });

  test("rejects a contact that belongs to a different account", async () => {
    const accA = await activeAccount({ companyName: "Account A" });
    const accB = await activeAccount({ companyName: "Account B" });
    const contactB = await Contact.create({ accountId: accB._id, firstName: "Mira", lastName: "K" });

    const res = await call("", { method: "POST", body: validBody(accA._id, { primaryContactId: String(contactB._id) }) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not belong/i);
    expect(await SalesJourney.countDocuments()).toBe(0);
  });

  test("rejects an inactive commercial party", async () => {
    const acc = await activeAccount();
    const deadBrand = await activeAccount({ companyName: "Dead Brand", status: "inactive" });
    const res = await call("", {
      method: "POST",
      body: validBody(acc._id, { parties: { brandAccountId: String(deadBrand._id) } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not active/i);
  });

  test("reports partial failure when the Journey saves but its task does not", async () => {
    const acc = await activeAccount();
    const spy = jest.spyOn(Activity, "create").mockRejectedValueOnce(new Error("activity store offline"));

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { nextAction: { label: "Chase size breakdown" } }),
    });

    // The Journey is real and usable, so this is a 201 — but it is NOT reported
    // as an unqualified success.
    expect(status).toBe(201);
    expect(body.journey.reference).toMatch(/^SJ-/);
    expect(body.warning).toMatch(/could not be saved/i);
    expect(body.journey.nextAction).toBeNull();
    spy.mockRestore();
  });

  test("an unauthenticated caller is refused", async () => {
    const acc = await activeAccount();
    expect((await call("", { method: "POST", body: validBody(acc._id), user: null })).status).toBe(401);
  });
});

/* ── List ─────────────────────────────────────────────────────────────────── */

describe("GET /sales-journeys", () => {
  async function seed() {
    const accA = await activeAccount({ companyName: "Northstar Buying Services" });
    const accB = await activeAccount({ companyName: "Riverside Schools Trust" });
    await call("", { method: "POST", body: validBody(accA._id, { name: "Mine — AW26" }), user: OWNER });
    await call("", { method: "POST", body: validBody(accB._id, { name: "Theirs — Blazers", businessType: "repeat" }), user: OTHER_USER });
    return { accA, accB };
  }

  test("team scope returns everything; mine returns only the caller's", async () => {
    await seed();
    expect((await call("?scope=team")).body.journeys).toHaveLength(2);

    const mine = (await call("?scope=mine", { user: OWNER })).body.journeys;
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("Mine — AW26");
  });

  test("MY WORK CANNOT BE IMPERSONATED through the query string", async () => {
    await seed();
    // Asking for someone else's work while claiming `mine` still returns mine.
    const res = await call(`?scope=mine&owner=${OTHER_USER.id}`, { user: OWNER });
    expect(res.body.journeys).toHaveLength(1);
    expect(res.body.journeys[0].name).toBe("Mine — AW26");
  });

  test("filters by account, business type and stage", async () => {
    const { accA } = await seed();
    expect((await call(`?scope=team&accountId=${accA._id}`)).body.journeys).toHaveLength(1);
    expect((await call("?scope=team&businessType=repeat")).body.journeys).toHaveLength(1);
    // New journeys start at Enquiry (the "account" stage was removed).
    expect((await call("?scope=team&stage=enquiry")).body.journeys).toHaveLength(2);
    expect((await call("?scope=team&stage=production")).body.journeys).toHaveLength(0);
  });

  test("searches Journey name and the customer's name alike", async () => {
    await seed();
    expect((await call("?scope=team&search=AW26")).body.journeys).toHaveLength(1);
    // "Riverside" is on the ACCOUNT, not the Journey.
    const byCustomer = (await call("?scope=team&search=Riverside")).body.journeys;
    expect(byCustomer).toHaveLength(1);
    expect(byCustomer[0].name).toBe("Theirs — Blazers");
  });

  test("paginates", async () => {
    await seed();
    const res = await call("?scope=team&limit=1&page=1");
    expect(res.body.journeys).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 1, total: 2, pages: 2 });
  });

  test("dates go out as real dates and never as relative text", async () => {
    const acc = await activeAccount();
    await call("", {
      method: "POST",
      body: validBody(acc._id, { targetDate: { label: "Tender close", date: "2030-01-15" } }),
    });
    const row = (await call("?scope=team")).body.journeys[0];
    expect(row.targetDate.label).toBe("Tender close");
    expect(new Date(row.targetDate.date).getUTCFullYear()).toBe(2030);
    expect(JSON.stringify(row)).not.toMatch(/in \d+ days|yesterday|tomorrow/);
  });
});

/* ── Commercial visibility over the wire ──────────────────────────────────── */

describe("expected value never reaches an unauthorized client", () => {
  async function seedValued() {
    const acc = await activeAccount();
    await call("", {
      method: "POST",
      body: validBody(acc._id, { expectedValue: { amount: 4820000, currency: "INR" } }),
      user: ADMIN,
    });
  }

  test("is absent from the list for a plain sales user, present for an admin", async () => {
    await seedValued();

    const forSales = await call("?scope=team", { user: OWNER });
    expect(forSales.body.journeys[0].expectedValue ?? null).toBeNull();
    expect(JSON.stringify(forSales.body)).not.toContain("4820000");

    const forAdmin = await call("?scope=team", { user: ADMIN });
    expect(forAdmin.body.journeys[0].expectedValue.amount).toBe(4820000);
  });

  test("is absent from the detail response too", async () => {
    await seedValued();
    const ref = (await call("?scope=team", { user: ADMIN })).body.journeys[0].reference;

    const forSales = await call(`/${ref}`, { user: OWNER });
    expect(JSON.stringify(forSales.body)).not.toContain("4820000");

    const forAdmin = await call(`/${ref}`, { user: ADMIN });
    expect(forAdmin.body.journey.expectedValue.amount).toBe(4820000);
  });

  test("the value-range filter is ignored for an unauthorized caller", async () => {
    await seedValued();
    // An unauthorized caller must not be able to probe the value by filtering.
    const probe = await call("?scope=team&valueMin=4000000", { user: OWNER });
    expect(probe.body.journeys).toHaveLength(1);

    const authorized = await call("?scope=team&valueMin=5000000", { user: ADMIN });
    expect(authorized.body.journeys).toHaveLength(0);
  });
});

/* ── Detail ───────────────────────────────────────────────────────────────── */

describe("GET /sales-journeys/:journeyId", () => {
  test("is addressed by the human reference, and exposes no Mongo id for it", async () => {
    const acc = await activeAccount();
    const created = await call("", { method: "POST", body: validBody(acc._id) });
    const ref = created.body.journey.reference;

    const { status, body } = await call(`/${ref}`);
    expect(status).toBe(200);
    expect(body.journey.id).toBe(ref);
    expect(body.journey.reference).toBe(ref);

    // The customer's id is needed to open the Account; the JOURNEY's own Mongo
    // id is not, and must not be the route key.
    const saved = await SalesJourney.findOne({ journeyId: ref }).lean();
    expect(body.journey.id).not.toBe(String(saved._id));
  });

  test("returns all eight stage states and the resolved parties", async () => {
    const acc = await activeAccount();
    const brand = await activeAccount({ companyName: "Harbor & Field" });
    const created = await call("", {
      method: "POST",
      body: validBody(acc._id, { parties: { brandAccountId: String(brand._id) } }),
    });

    const { body } = await call(`/${created.body.journey.reference}`);
    expect(Object.keys(body.journey.stageStates)).toHaveLength(8);
    expect(body.journey.parties.brand.name).toBe("Harbor & Field");
    expect(body.journey.parties.buyingHouse).toBeNull();
  });

  test("an unknown reference is a real 404", async () => {
    const { status, body } = await call("/SJ-1999-9999");
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

/* ── The Lead → Journey bridge (sourceLeadId) ────────────────────────────── */

describe("POST /sales-journeys with sourceLeadId — the Lead conversion bridge", () => {
  test("converts a Ready-for-Journey Lead: Journey created, Lead flipped and linked", async () => {
    const acc = await activeAccount();
    const lead = await readyLead();

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { sourceLeadId: String(lead._id) }),
    });

    expect(status).toBe(201);
    expect(body.journey.currentStage).toBe("enquiry");

    const updated = await Lead.findById(lead._id).lean();
    expect(updated.qualificationState).toBe("converted");
    expect(updated.stage).toBe("won"); // LEAD_QUALIFICATION_TO_LEGACY_STAGE.converted
    expect(String(updated.conversion.accountId)).toBe(String(acc._id));
    expect(String(updated.conversion.journeyId)).toBe(String((await SalesJourney.findOne({ journeyId: body.journey.reference }))._id));
    expect(updated.conversion.convertedAt).toBeTruthy();
    expect(String(updated.conversion.convertedBy.id)).toBe(OWNER.id);

    // Audited on the Lead side too, not just the Journey.
    expect(recordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entity: "lead", action: "update", summary: expect.stringContaining("converted to Sales Journey") }),
    );
  });

  test("carries the Lead's decision-maker across as the Account's primary contact", async () => {
    const acc = await activeAccount(); // no contacts yet
    const lead = await readyLead({
      contacts: [
        { name: "Ravi Menon", role: "Procurement Head", email: "ravi@northstar.test", phone: "+91 90000 11111", isDecisionMaker: true },
        { name: "Junior Buyer", role: "Buyer" },
      ],
    });

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { sourceLeadId: String(lead._id) }),
    });
    expect(status).toBe(201);

    const seeded = await Contact.find({ accountId: acc._id, isActive: true }).lean();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].firstName).toBe("Ravi");
    expect(seeded[0].lastName).toBe("Menon");
    expect(seeded[0].isPrimary).toBe(true);
    expect(seeded[0].roles).toContain("decision_maker");
    // …and the new Journey names that contact as its primary.
    expect(String(body.journey.primaryContact?.id || "")).toBe(String(seeded[0]._id));
  });

  test("does not seed a contact when the Account already has one", async () => {
    const acc = await activeAccount();
    await Contact.create({ accountId: acc._id, firstName: "Existing", lastName: "Person", isPrimary: true });
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", isDecisionMaker: true }] });

    const { status } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    expect(status).toBe(201);
    expect(await Contact.countDocuments({ accountId: acc._id, isActive: true })).toBe(1);
  });

  test("refuses a Lead that is not Ready for Journey, and creates nothing", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ qualificationState: "qualified" });

    const { status, body } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });

    expect(status).toBe(400);
    expect(body.message).toMatch(/ready for journey/i);
    expect(await SalesJourney.countDocuments({})).toBe(0);
    expect((await Lead.findById(lead._id).lean()).qualificationState).toBe("qualified");
  });

  test("refuses a Prospect (draft) outright", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ captureStatus: "draft", qualificationState: "new" });

    const { status, body } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });

    expect(status).toBe(400);
    expect(body.message).toMatch(/prospects cannot start a sales journey/i);
  });

  test("a Lead that already converted cannot start a second Journey (idempotency)", async () => {
    const acc = await activeAccount();
    const lead = await readyLead();

    const first = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id), name: "First" }) });
    expect(first.status).toBe(201);

    const second = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id), name: "Second" }) });
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/already started a sales journey/i);
    expect(await SalesJourney.countDocuments({})).toBe(1); // not two
  });

  test("loses the flip race → rolls back the Journey and its Activity, no orphan left behind", async () => {
    const acc = await activeAccount();
    const lead = await readyLead();

    // Force the ATOMIC conditional update to report "someone else got there
    // first" — the one path a sequential test can't otherwise reach without
    // real concurrency. This is what proves the rollback code, not just its
    // absence of a crash.
    const spy = jest.spyOn(Lead, "findOneAndUpdate").mockResolvedValueOnce(null);
    try {
      const { status, body } = await call("", {
        method: "POST",
        body: validBody(acc._id, { sourceLeadId: String(lead._id), nextAction: { label: "Kick off" } }),
      });
      expect(status).toBe(409);
      expect(body.message).toMatch(/already started a sales journey/i);
    } finally {
      spy.mockRestore();
    }

    // No orphaned Journey and no orphaned Activity survive the rollback.
    expect(await SalesJourney.countDocuments({})).toBe(0);
    expect(await Activity.countDocuments({})).toBe(0);
    // The Lead itself was never actually touched by the losing request.
    expect((await Lead.findById(lead._id).lean()).qualificationState).toBe("readyToConvert");
  });

  test("an invalid or missing sourceLeadId is a clear 400, not a 500", async () => {
    const acc = await activeAccount();
    const badRef = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: "not-an-id" }) });
    expect(badRef.status).toBe(400);

    const missing = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: new mongoose.Types.ObjectId().toString() }) });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/not found/i);
  });

  test("creating a Journey with no sourceLeadId never touches any Lead (unchanged behaviour)", async () => {
    const acc = await activeAccount();
    const lead = await readyLead();
    const { status } = await call("", { method: "POST", body: validBody(acc._id) });
    expect(status).toBe(201);
    expect((await Lead.findById(lead._id).lean()).qualificationState).toBe("readyToConvert");
  });
});

/* ── Stage progression ──────────────────────────────────────────────────────
   POST /:journeyId/stage — the lifecycle mover (advance / setState / block /
   reopen). A journey used to be frozen at account/inProgress forever; these
   assert it now moves, with the gates enforced. */

describe("POST /sales-journeys/:journeyId/stage", () => {
  /** An account complete enough to clear the Account → Enquiry gate. */
  const enquiryReadyAccount = async () => {
    const acc = await activeAccount({
      roles: ["uniform_client"],
      assignedToName: "Owner Person",
      garmentSalesProfile: { businessModels: ["uniforms"] },
    });
    await Contact.create({ accountId: acc._id, firstName: "Priya", lastName: "Nair", isPrimary: true });
    await Site.create({ accountId: acc._id, name: "Head office", siteType: "head_office" });
    return acc;
  };

  /** Create a real Journey owned by `user` and return its reference. The
   *  account is enquiry-ready so these lifecycle tests (which aren't about the
   *  Account gate) can advance off the Account stage. */
  const startJourney = async (user = OWNER, over = {}) => {
    const acc = await enquiryReadyAccount();
    const { status, body } = await call("", { method: "POST", body: validBody(acc._id, over), user });
    expect(status).toBe(201);
    recordChange.mockClear(); // so a test can count only its own transition's audit
    return body.journey.reference;
  };

  test("advance completes the current stage and opens the next", async () => {
    const ref = await startJourney();
    const { status, body } = await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" } });

    expect(status).toBe(200);
    expect(body.journey.currentStage).toBe("styleSample");
    expect(body.journey.currentStageState).toBe("inProgress");
    expect(body.journey.stageStates.enquiry).toBe("complete");
    expect(body.journey.stageStates.styleSample).toBe("inProgress");
    expect(recordChange).toHaveBeenCalledTimes(1);
  });

  test("only the owner or a manager may move a Journey", async () => {
    const ref = await startJourney(OWNER);

    // A different ordinary salesperson (not the owner, no manager role) is 403.
    const denied = await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" }, user: OTHER_USER });
    expect(denied.status).toBe(403);

    // An admin (org-level manager) may move anyone's Journey.
    const allowed = await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" }, user: ADMIN });
    expect(allowed.status).toBe(200);
    expect(allowed.body.journey.currentStage).toBe("styleSample");
  });

  test("setState sets a working state on the current stage", async () => {
    const ref = await startJourney();
    const { status, body } = await call(`/${ref}/stage`, {
      method: "POST",
      body: { action: "setState", toState: "waitingCustomer" },
    });
    expect(status).toBe(200);
    expect(body.journey.stageStates.enquiry).toBe("waitingCustomer");
    expect(body.journey.waitingOn).toBe("customer");
  });

  test("setState rejects a non-settable state (blocked/reopened/notStarted)", async () => {
    const ref = await startJourney();
    for (const toState of ["blocked", "reopened", "notStarted", "nonsense"]) {
      const { status } = await call(`/${ref}/stage`, { method: "POST", body: { action: "setState", toState } });
      expect(status).toBe(400);
    }
  });

  test("block needs a reason, and a blocked stage cannot advance", async () => {
    const ref = await startJourney();

    const noReason = await call(`/${ref}/stage`, { method: "POST", body: { action: "block" } });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason is required/i);

    const blocked = await call(`/${ref}/stage`, { method: "POST", body: { action: "block", reason: "Awaiting client GST details" } });
    expect(blocked.status).toBe(200);
    expect(blocked.body.journey.stageStates.enquiry).toBe("blocked");

    const cannotAdvance = await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" } });
    expect(cannotAdvance.status).toBe(400);
    expect(cannotAdvance.body.message).toMatch(/blocked/i);
  });

  test("reopen sends a completed stage back and moves the pointer to it", async () => {
    const ref = await startJourney();
    await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" } }); // enquiry -> styleSample

    const reopened = await call(`/${ref}/stage`, {
      method: "POST",
      body: { action: "reopen", stage: "enquiry", reason: "Requirement changed" },
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.journey.currentStage).toBe("enquiry");
    expect(reopened.body.journey.stageStates.enquiry).toBe("reopened");

    // A stage that isn't complete cannot be reopened.
    const notComplete = await call(`/${ref}/stage`, {
      method: "POST",
      body: { action: "reopen", stage: "styleSample", reason: "x" },
    });
    expect(notComplete.status).toBe(400);
  });

  test("advancing off the final stage, and unknown actions, are clean 400s", async () => {
    const ref = await startJourney();
    // Walk to the last stage (6 advances: enquiry → … → retention).
    for (let i = 0; i < 6; i++) {
      const r = await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" } });
      expect(r.status).toBe(200);
    }
    const atEnd = await call(`/${ref}/stage`, { method: "POST", body: { action: "advance" } });
    expect(atEnd.status).toBe(400);
    expect(atEnd.body.message).toMatch(/final stage/i);

    const bad = await call(`/${ref}/stage`, { method: "POST", body: { action: "teleport" } });
    expect(bad.status).toBe(400);
  });

  test("a stage move on an unknown Journey is a 404", async () => {
    const { status } = await call(`/SJ-2099-9999/stage`, { method: "POST", body: { action: "advance" } });
    expect(status).toBe(404);
  });

  // (Removed 13 Aug 2026: the "Account → Enquiry is refused until the account is
  // complete" gate no longer exists — "account" is not a journey stage. The
  // customer is set up on the Active Lead before conversion.)
});

/* ── Pure planner ───────────────────────────────────────────────────────────
   A couple of rules that are awkward to reach over HTTP (notApplicable skip)
   verified directly against the DB-free service. */

describe("planStageTransition (service)", () => {
  const { planStageTransition } = require("../../services/salesJourneyProgress");

  test("advance skips a stage marked notApplicable", () => {
    const plan = planStageTransition(
      { currentStage: "account", stageStates: { account: "inProgress", enquiry: "notApplicable" } },
      { action: "advance" },
    );
    expect(plan.set.currentStage).toBe("styleSample");
    expect(plan.set["stageStates.account"]).toBe("complete");
    expect(plan.set["stageStates.styleSample"]).toBe("inProgress");
  });

  test("advance from the last stage throws", () => {
    expect(() =>
      planStageTransition({ currentStage: "retention", stageStates: { retention: "inProgress" } }, { action: "advance" }),
    ).toThrow(/final stage/i);
  });

  // (Removed 13 Aug 2026: the account-readiness gate no longer exists — "account"
  // is not a journey stage; the customer is set up on the Active Lead.)
});
