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
/** A minimal Active Lead, Enquiry Ready by default — the only state this
 *  bridge accepts. `leadId` is assigned directly (not through the ref-
 *  generator service) since these are route-level tests of the JOURNEY side
 *  of the bridge; Lead reference allocation has its own suite.
 *
 *  The fixture now also SATISFIES the Enquiry bar, not just carries its state.
 *  The bridge re-runs the checklist at creation time — the stored state records
 *  that the Lead cleared the bar once, and an ordinary edit can undo it — so a
 *  fixture with the label and none of the facts would have been testing a
 *  record that must legitimately be refused. */
const readyLead = (over = {}) =>
  Lead.create({
    leadId: `LEAD-2026-90${String(++leadSeq).padStart(2, "0")}`,
    company: "Northstar Buying Services",
    /* A buying house is an organisation, and `prospectType` defaults to
       "individual" — which allows exactly one contact. Promotion re-saves the
       Lead to record where each person went, so an untyped fixture with two
       contacts now trips the Lead's own Individual invariant. */
    prospectType: "company",
    qualificationState: "readyToConvert",
    stage: "qualified",
    phone: "9876500000",
    requirementItems: [{ product: "Housekeeping shirts", quantity: 500 }],
    productInterest: ["Housekeeping shirts"],
    estimatedQuantity: 500,
    requirementCertainty: "prospect_confirmed",
    decisionMakerName: "Ravi Kumar",
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


/* ── ONE COMPANY, SO OWNERSHIP CAN BE PROVED (Chunk 3A) ─────────────────────
 * SalesJourney creation now refuses unless the actor's company is provable.
 * These suites are not about tenancy, so they seed the simplest thing that
 * makes ownership provable: a single company, which is the documented
 * deployment fallback. Without it every journey-creating test fails on a
 * refusal that is correct. */
beforeEach(async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  if (!(await Acc_Company.countDocuments({}))) {
    await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  }
});

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

  /* ── EVERY PERSON, NOT THE ONE THE OLD RULE PICKED ──────────────────────
     This used to seed exactly ONE contact — "decision-maker, else the first
     one" — and only when the Account had none at all. A Lead carrying a
     merchandiser, a purchase manager and an admin head arrived with one of
     them, and the rest were re-typed by hand. Journey now shares the promotion
     service with POST /leads/:id/account, so both produce the same people. */
  test("carries EVERY person on the Lead across to the Account", async () => {
    const acc = await activeAccount(); // no contacts yet
    const lead = await readyLead({
      contacts: [
        { name: "Ravi Menon", role: "Procurement Head", email: "ravi@northstar.test", phone: "+91 90000 11111", isDecisionMaker: true, isPrimary: true },
        { name: "Junior Buyer", role: "Buyer" },
      ],
    });

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { sourceLeadId: String(lead._id) }),
    });
    expect(status).toBe(201);

    const seeded = await Contact.find({ accountId: acc._id, isActive: true }).lean();
    expect(seeded).toHaveLength(2);
    const ravi = seeded.find((c) => c.firstName === "Ravi");
    expect(ravi.lastName).toBe("Menon");
    expect(ravi.isPrimary).toBe(true);
    expect(ravi.roles).toContain("decision_maker");
    expect(seeded.some((c) => c.firstName === "Junior")).toBe(true);
    // The Journey names the CRM Contact the Lead's own primary became.
    expect(String(body.journey.primaryContact?.id || "")).toBe(String(ravi._id));
  });

  /* Previously this asserted the Lead's people were DROPPED whenever the
     Account already had somebody. That was never the right outcome — the
     Account's existing contact simply keeps the primary role. */
  test("an Account that already has a primary keeps it, and still gains the Lead's people", async () => {
    const acc = await activeAccount();
    const incumbent = await Contact.create({ accountId: acc._id, firstName: "Existing", lastName: "Person", isPrimary: true });
    /* The primary contact is the authority for the Lead's top-level phone, so a
       primary with no number would clear the very contact route that made this
       Lead Enquiry Ready. */
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isDecisionMaker: true, isPrimary: true }] });

    const { status, body } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    expect(status).toBe(201);

    const contacts = await Contact.find({ accountId: acc._id, isActive: true }).lean();
    expect(contacts).toHaveLength(2);
    const primaries = contacts.filter((c) => c.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(String(primaries[0]._id)).toBe(String(incumbent._id));
    expect(String(body.journey.primaryContact?.id || "")).toBe(String(incumbent._id));
  });

  test("an explicitly supplied primary contact is never overridden by promotion", async () => {
    const acc = await activeAccount();
    const chosen = await Contact.create({ accountId: acc._id, firstName: "Chosen", lastName: "One" });
    /* The primary contact is the authority for the Lead's top-level phone, so a
       primary with no number would clear the very contact route that made this
       Lead Enquiry Ready. */
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isDecisionMaker: true, isPrimary: true }] });

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { sourceLeadId: String(lead._id), primaryContactId: String(chosen._id) }),
    });
    expect(status).toBe(201);
    expect(String(body.journey.primaryContact?.id || "")).toBe(String(chosen._id));
    // Ravi still came across — he just did not take the role.
    expect(await Contact.countDocuments({ accountId: acc._id, isActive: true })).toBe(2);
  });

  test("refuses a Lead that is not Enquiry Ready, and creates nothing", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ qualificationState: "qualified" });

    const { status, body } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });

    expect(status).toBe(400);
    expect(body.message).toMatch(/enquiry ready/i);
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

  /* ── PROMOTION IS NOT THE LAST THING THIS REQUEST DOES ──────────────────
     A Journey promotes the Lead's people and then keeps working: it inserts
     the Journey, flips the Lead, writes an audit entry. Any of those can fail,
     and until now the only thing put back was the contacts promotion had
     CREATED. Fields filled on contacts that already existed, `linkedLeads`
     entries and every `promotedContactId` written onto the Lead all survived a
     failed request — so the Lead believed its people were promoted for a
     customer conversion that never happened. */

  test("losing the flip race undoes the promotion, not just the contacts it created", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({
      contacts: [
        { name: "Ravi Menon", phone: "9876500000", isDecisionMaker: true, isPrimary: true },
        { name: "Junior Buyer", phone: "9876500123" },
      ],
    });

    const spy = jest.spyOn(Lead, "findOneAndUpdate").mockResolvedValueOnce(null);
    try {
      const { status } = await call("", {
        method: "POST",
        body: validBody(acc._id, { sourceLeadId: String(lead._id) }),
      });
      expect(status).toBe(409);
    } finally {
      spy.mockRestore();
    }

    expect(await Contact.countDocuments({ accountId: acc._id })).toBe(0);
    const after = await Lead.findById(lead._id).lean();
    expect(after.contacts.every((c) => !c.promotedContactId)).toBe(true);
  });

  test("a matched contact is restored when the request fails after promotion", async () => {
    const acc = await activeAccount();
    /* Already on the customer, with no job title and linked to nobody — the
       two things promotion would have changed. */
    const incumbent = await Contact.create({
      accountId: acc._id, firstName: "Ravi", lastName: "Menon", phone: "9876500000",
    });
    const lead = await readyLead({
      contacts: [{ name: "Ravi Menon", jobTitle: "Procurement Head", phone: "9876500000", isPrimary: true, isDecisionMaker: true }],
    });

    const spy = jest.spyOn(Lead, "findOneAndUpdate").mockResolvedValueOnce(null);
    try {
      await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    } finally {
      spy.mockRestore();
    }

    const after = await Contact.findById(incumbent._id).lean();
    expect(after.jobTitle == null).toBe(true);          // the fill was undone
    expect(after.linkedLeads).toEqual([]);              // and so was the link
    expect(await Contact.countDocuments({ accountId: acc._id })).toBe(1);
    const leadAfter = await Lead.findById(lead._id).lean();
    expect(leadAfter.contacts[0].promotedContactId == null).toBe(true);
  });

  test("a failure after promotion, anywhere, still puts the people back", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({
      contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }],
    });

    /* The audit write is the last thing this route does — well past promotion,
       and the exact window where a throw used to escape with the contacts
       already created. */
    const { recordChange } = require("../../services/changeLog");
    recordChange.mockRejectedValueOnce(new Error("audit store unreachable"));

    const { status } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    expect(status).toBeGreaterThanOrEqual(400);

    expect(await Contact.countDocuments({ accountId: acc._id })).toBe(0);
    const after = await Lead.findById(lead._id).lean();
    expect(after.contacts.every((c) => !c.promotedContactId)).toBe(true);
  });

  /* ── AN ARCHIVED CONTACT IS NOT A VALID CHOICE ──────────────────────────── */

  test("an archived contact cannot be named as the Journey's primary", async () => {
    const acc = await activeAccount();
    const archived = await Contact.create({
      accountId: acc._id, firstName: "Gone", lastName: "Person",
      isActive: false, status: "archived", archivedAt: new Date(),
    });

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { primaryContactId: String(archived._id) }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/archived, marked do-not-contact, or otherwise not contactable/i);
  });

  test("a contact who has left cannot be named as the Journey's primary either", async () => {
    const acc = await activeAccount();
    const departed = await Contact.create({
      accountId: acc._id, firstName: "Left", lastName: "Person", status: "left_organization",
    });

    const { status } = await call("", {
      method: "POST",
      body: validBody(acc._id, { primaryContactId: String(departed._id) }),
    });
    expect(status).toBe(400);
  });

  /* ── ONE COMMIT BOUNDARY, AND COMPLETE STATE ON EITHER SIDE ─────────────
     The core operation is the promoted contacts, the Journey, its optional
     first Activity and the Lead's conversion. It commits when the conditional
     Lead flip succeeds. Before that, a failure takes ALL of it; after it,
     nothing is reversed and the problem is reported as a warning.

     Partial rollback was the bug: the outer catch undid only the contact
     promotion, leaving a Journey and a converted Lead pointing at contacts
     that no longer existed. Each test below asserts the WHOLE final state. */

  const wholeState = async (acc, lead) => ({
    journeys: await SalesJourney.countDocuments({}),
    activities: await Activity.countDocuments({}),
    contacts: await Contact.countDocuments({ accountId: acc._id }),
    account: await Account.countDocuments({ _id: acc._id }),
    lead: await Lead.findById(lead._id).lean(),
  });

  test("a Journey insert failure leaves no Journey, no contacts and an unconverted Lead", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }] });

    const spy = jest.spyOn(SalesJourney, "create").mockRejectedValueOnce(new Error("insert failed"));
    try {
      await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    } finally { spy.mockRestore(); }

    const state = await wholeState(acc, lead);
    expect(state.journeys).toBe(0);
    expect(state.activities).toBe(0);
    expect(state.contacts).toBe(0);
    expect(state.account).toBe(1);                                  // never this route's to delete
    expect(state.lead.qualificationState).toBe("readyToConvert");
    expect(state.lead.conversion?.journeyId == null).toBe(true);
    expect(state.lead.contacts.every((c) => !c.promotedContactId)).toBe(true);
  });

  test("a Journey audit failure — before the commit — takes the whole operation with it", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }] });

    const { recordChange } = require("../../services/changeLog");
    recordChange.mockRejectedValueOnce(new Error("audit store unreachable"));

    const { status } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    expect(status).toBeGreaterThanOrEqual(400);

    const state = await wholeState(acc, lead);
    expect(state.journeys).toBe(0);
    expect(state.activities).toBe(0);
    expect(state.contacts).toBe(0);
    expect(state.lead.qualificationState).toBe("readyToConvert");
    expect(state.lead.contacts.every((c) => !c.promotedContactId)).toBe(true);
  });

  /* The one deliberate exception, preserved: the first action is OPTIONAL, so
     losing it returns a usable Journey with a warning — and the promotion that
     came with it must survive intact, because the operation did commit. */
  test("a failed optional first action still returns a Journey, with its contacts kept", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }] });

    const spy = jest.spyOn(Activity, "create").mockRejectedValueOnce(new Error("activity store down"));
    let body;
    try {
      ({ body } = await call("", {
        method: "POST",
        body: validBody(acc._id, { sourceLeadId: String(lead._id), nextAction: { label: "Kick off" } }),
      }));
    } finally { spy.mockRestore(); }

    expect(body.success).toBe(true);
    expect(body.warning).toMatch(/first next action could not be saved/i);

    const state = await wholeState(acc, lead);
    expect(state.journeys).toBe(1);
    expect(state.activities).toBe(0);
    expect(state.contacts).toBe(1);                                  // promotion kept
    expect(state.lead.qualificationState).toBe("converted");
    expect(state.lead.contacts[0].promotedContactId).toBeTruthy();
  });

  test("losing the conversion race removes the Journey, the Activity and the promotion together", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }] });

    const spy = jest.spyOn(Lead, "findOneAndUpdate").mockResolvedValueOnce(null);
    try {
      const { status } = await call("", {
        method: "POST",
        body: validBody(acc._id, { sourceLeadId: String(lead._id), nextAction: { label: "Kick off" } }),
      });
      expect(status).toBe(409);
    } finally { spy.mockRestore(); }

    const state = await wholeState(acc, lead);
    expect(state.journeys).toBe(0);
    expect(state.activities).toBe(0);
    expect(state.contacts).toBe(0);
    expect(state.account).toBe(1);
    expect(state.lead.qualificationState).toBe("readyToConvert");
    expect(state.lead.contacts.every((c) => !c.promotedContactId)).toBe(true);
  });

  test("a Lead-audit failure — after the commit — keeps everything and warns", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }] });

    const { recordChange } = require("../../services/changeLog");
    /* First call is the Journey audit (pre-commit) and must succeed; the
       SECOND is the Lead's, written after the conversion has committed. */
    recordChange.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit store unreachable"));

    const { status, body } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) });
    expect(status).toBe(201);
    expect(body.warning).toMatch(/audit entry could not be written/i);

    const state = await wholeState(acc, lead);
    expect(state.journeys).toBe(1);
    expect(state.contacts).toBe(1);
    expect(state.lead.qualificationState).toBe("converted");        // never reversed
    /* `journey.id` in the DTO is the human reference (SJ-…), so the link is
       checked against the actual document. */
    const stored = await SalesJourney.findOne({}).lean();
    expect(String(state.lead.conversion.journeyId)).toBe(String(stored._id));
    expect(state.lead.contacts[0].promotedContactId).toBeTruthy();
  });

  test("a failed final reload still reports the committed Journey", async () => {
    const acc = await activeAccount();
    const lead = await readyLead({ contacts: [{ name: "Ravi Menon", phone: "9876500000", isPrimary: true, isDecisionMaker: true }] });

    /* The reload is the LAST findOne on the model, well past the commit point.
       Failing it must not reverse a conversion other requests can already see. */
    const real = SalesJourney.findOne.bind(SalesJourney);
    let calls = 0;
    const spy = jest.spyOn(SalesJourney, "findOne").mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) throw new Error("reload failed");
      return real(...args);
    });
    let status, body;
    try {
      ({ status, body } = await call("", { method: "POST", body: validBody(acc._id, { sourceLeadId: String(lead._id) }) }));
    } finally { spy.mockRestore(); }

    expect(status).toBe(201);
    expect(body.warning).toMatch(/could not be re-read/i);
    expect(body.journey.journeyId).toBeTruthy();

    const state = await wholeState(acc, lead);
    expect(state.journeys).toBe(1);
    expect(state.contacts).toBe(1);
    expect(state.lead.qualificationState).toBe("converted");
    expect(state.lead.contacts[0].promotedContactId).toBeTruthy();
  });

  /* ── A SUPPRESSED PERSON IS NOT A PRIMARY ──────────────────────────────── */

  test("a do-not-contact contact cannot be named as the Journey's primary", async () => {
    const acc = await activeAccount();
    const suppressed = await Contact.create({
      accountId: acc._id, firstName: "Do", lastName: "NotCall",
      status: "active", isActive: true, doNotContact: true,
    });

    const { status, body } = await call("", {
      method: "POST",
      body: validBody(acc._id, { primaryContactId: String(suppressed._id) }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/do-not-contact/i);
  });

  test("a do-not-contact Account primary is not inherited as the Journey's primary", async () => {
    const acc = await activeAccount();
    await Contact.create({
      accountId: acc._id, firstName: "Do", lastName: "NotCall",
      isPrimary: true, status: "active", isActive: true, doNotContact: true,
    });

    const { status, body } = await call("", { method: "POST", body: validBody(acc._id) });
    expect(status).toBe(201);
    // Better no primary than a suppressed one.
    expect(body.journey.primaryContact?.id == null).toBe(true);
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


/* ══ THE STORED STATE IS A MEMORY, NOT A GUARANTEE ═════════════════════════
 * `readyToConvert` records that a Lead cleared the Enquiry bar at some moment
 * in the past. Nothing re-checked it afterwards, and an ordinary edit can undo
 * it — so a Journey could be raised against a Lead that no longer satisfied a
 * single one of the rules it was let through on.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("a stale Ready-for-Enquiry Lead cannot start a Journey", () => {
  const createJourney = (lead, account) => call("", {
    method: "POST",
    body: validBody(account._id, { sourceLeadId: String(lead._id) }),
  });

  test("a Lead that still meets the bar creates exactly one Journey", async () => {
    const account = await activeAccount();
    const lead = await readyLead();
    const r = await createJourney(lead, account);
    expect(r.status).toBe(201);
    expect(await SalesJourney.countDocuments({ leadId: lead._id })).toBe(1);
    expect((await Lead.findById(lead._id).lean()).qualificationState).toBe("converted");
  });

  for (const [what, patch, expected] of [
    ["its decision-maker was removed", { decisionMakerName: "", contacts: [] }, /decision-maker/i],
    ["its requirement certainty was downgraded to suspected", { requirementCertainty: "suspected" }, /confirmed by the customer or a document/i],
    ["its only contact route was removed", { phone: "", email: "", whatsapp: "" }, /contact route/i],
    ["a researched estimate lost its source", { estimatedAnnualQuantity: 12000, estimatedAnnualQuantityConfidence: "researched" }, /source/i],
  ]) {
    test(`refuses it after ${what}, and creates nothing`, async () => {
      const account = await activeAccount();
      const lead = await readyLead();
      await Lead.updateOne({ _id: lead._id }, { $set: patch });

      const r = await createJourney(lead, account);
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/no longer meets the bar/i);
      expect(r.body.message).toMatch(expected);

      // nothing created, and the Lead is NOT partially converted
      expect(await SalesJourney.countDocuments({ leadId: lead._id })).toBe(0);
      const after = await Lead.findById(lead._id).lean();
      expect(after.qualificationState).toBe("readyToConvert");
      expect(after.conversion?.journeyId).toBeUndefined();
      expect(after.conversion?.accountId).toBeUndefined();
    });
  }

  test("the refusal names every missing item, not just the first", async () => {
    const account = await activeAccount();
    const lead = await readyLead();
    await Lead.updateOne({ _id: lead._id }, { $set: { decisionMakerName: "", contacts: [], requirementCertainty: "suspected" } });
    const r = await createJourney(lead, account);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/decision-maker/i);
    expect(r.body.message).toMatch(/confirmed by the customer or a document/i);
  });
});
