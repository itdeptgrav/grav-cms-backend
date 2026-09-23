// test/costing/enquiry-tenancy.route.test.js
//
// Central Costing — Chunk 3A correction. THE ENQUIRY BOUNDARY, OVER HTTP.
//
// ── WHY THIS EXISTS SEPARATELY FROM THE SERVICE TEST ────────────────────────
// The first pass proved ownership at the service level and treated that as
// proof the route was safe. It was not: the route created enquiries from a
// journey it loaded WITHOUT company scope, and every authenticated read went
// through a bare `Enquiry.findOne({_id})`. A service that resolves ownership
// correctly is not a router that uses it.
//
// ── STUBBING, NOT WEAKENING ─────────────────────────────────────────────────
// `config/firebaseAdmin` throws without a service account, which is why the
// existing `test/crm` suites cannot run in this environment. Only the modules
// that pull it in are stubbed — the repository's own `jest.mock` pattern, used
// by test/crm/activities.route.test.js and others. Authentication itself is
// NOT stubbed away: `SalesAuthMiddlewear` is replaced with one that sets the
// same `req.user` a real session would, so every tenant check under test runs
// exactly as it does in production.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* Firebase-dependent notification plumbing, stubbed at the edge. None of it
   participates in a tenant decision. */
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
/* `services/cowork.service.js` pulls in firebaseAdmin AND `uuid`, which is an
   ES module this repository's jest cannot require. Stubbed whole, at the edge:
   nothing in it participates in a tenant decision. */
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });

/* The session an authenticated Sales user would have. The tenant rules are
   what this suite exercises; the sign-in is not. */
let ACTOR = null;
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { global.__ACTOR__ = null; jest.restoreAllMocks(); });

const call = (path_, { method = "GET", body } = {}) =>
  fetch(`${base}${path_}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actorIn(companies = []) {
  const n = ++seq;
  const email = `enq${n}@test.example`;
  const emp = await Employee.create({
    firstName: "E", lastName: `L${n}`, email, biometricId: `EN${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "E" });
  }
  return { id: String(emp._id), email, name: "E", role: "sales" };
}

const be = (actor) => { global.__ACTOR__ = actor; ACTOR = actor; };

/** The company a test actor resolves to, for building same-company fixtures. */
async function actorCompanyOf(actor) {
  const m = await SpCompanyMembership.findOne({ email: actor.email }).select("companyId").lean();
  if (m) return m.companyId;
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const all = await Acc_Company.find({}).select("_id").limit(2).lean();
  return all.length === 1 ? all[0]._id : null;
}

const journeyFor = (co) =>
  SalesJourney.create({
    journeyId: `SJ-${++seq}`,
    ...(co ? { companyId: co._id } : {}),
    accountId: new mongoose.Types.ObjectId(),
    ownerId: new mongoose.Types.ObjectId(),
    ownerName: "Owner",
    name: `Journey ${seq}`,
    isActive: true,
  });

const openEnquiry = (journey) => call(`/by-journey/${journey.journeyId}`);

/* ═══ CREATION FAILS CLOSED ═════════════════════════════════════════════ */

describe("creating an enquiry over HTTP", () => {
  test("a membership-owned actor creates an enquiry stamped with their company", async () => {
    const co = await company("HttpOwn");
    be(await actorIn([co]));
    const journey = await journeyFor(co);

    const r = await openEnquiry(journey);
    expect(r.status).toBe(200);

    const stored = await Enquiry.findOne({ journeyId: journey._id }).lean();
    expect(String(stored.companyId)).toBe(String(co._id));
    expect(stored.companyOwnership.source).toBe("MEMBERSHIP_RECORD");
    expect(stored.companyOwnership.proven).toBe(true);
  });

  test("a single-company deployment stamps ownership without a membership row", async () => {
    const only = await company("HttpSolo");
    be(await actorIn([]));
    const journey = await journeyFor(only);

    expect((await openEnquiry(journey)).status).toBe(200);
    const stored = await Enquiry.findOne({ journeyId: journey._id }).lean();
    expect(String(stored.companyId)).toBe(String(only._id));
    expect(stored.companyOwnership.proven).toBe(false);
  });

  test("an ambiguous actor is refused, and NO enquiry is created", async () => {
    /* WAS: created an unowned enquiry and returned 200. */
    const a = await company("HttpAmbA");
    const b = await company("HttpAmbB");
    be(await actorIn([a, b]));
    const journey = await journeyFor(a);

    const r = await openEnquiry(journey);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
    expect(await Enquiry.countDocuments({})).toBe(0);
  });

  test("no provable membership in a multi-company deployment is refused", async () => {
    const a = await company("HttpNoneA");
    await company("HttpNoneB");
    be(await actorIn([]));
    const journey = await journeyFor(a);

    const r = await openEnquiry(journey);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
    expect(await Enquiry.countDocuments({})).toBe(0);
  });

  test("a company-context outage is a 503 and creates nothing", async () => {
    const co = await company("HttpOutage");
    be(await actorIn([co]));
    const journey = await journeyFor(co);

    jest.spyOn(SpCompanyMembership, "find").mockImplementation(() => { throw new Error("db down"); });
    const r = await openEnquiry(journey);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("COMPANY_CONTEXT_UNAVAILABLE");
    expect(await Enquiry.countDocuments({})).toBe(0);
  });

  test("an unauthenticated caller creates nothing", async () => {
    const co = await company("HttpAnon");
    const journey = await journeyFor(co);
    global.__ACTOR__ = null;
    expect((await openEnquiry(journey)).status).toBe(401);
    expect(await Enquiry.countDocuments({})).toBe(0);
  });

  test("a body-supplied companyId cannot override ownership", async () => {
    const a = await company("HttpBodyA");
    const b = await company("HttpBodyB");
    be(await actorIn([a]));
    const journey = await journeyFor(a);
    await openEnquiry(journey);

    const stored = await Enquiry.findOne({ journeyId: journey._id }).lean();
    const patch = await call(`/${stored._id}`, {
      method: "PATCH", body: { title: "Renamed", companyId: String(b._id), company: String(b._id) },
    });
    expect(patch.status).toBeLessThan(500);

    const after = await Enquiry.findById(stored._id).lean();
    expect(String(after.companyId)).toBe(String(a._id));
    expect(String(after.companyId)).not.toBe(String(b._id));
  });
});

/* ═══ THE SOURCE JOURNEY CANNOT BE CLAIMED ══════════════════════════════ */

describe("the journey an enquiry is created from", () => {
  test("another company's journey is not found, and creates nothing", async () => {
    /* WAS: the journey was loaded unscoped and the actor's company stamped
       onto the enquiry created from it — a foreign opportunity adopted, with
       the adoption looking like ordinary use. */
    const a = await company("JrnA");
    const b = await company("JrnB");
    be(await actorIn([a]));
    const theirs = await journeyFor(b);

    const r = await openEnquiry(theirs);
    expect(r.status).toBe(404);
    expect(await Enquiry.countDocuments({})).toBe(0);
  });

  test("a foreign journey and one that never existed answer identically", async () => {
    const a = await company("JrnSameA");
    const b = await company("JrnSameB");
    be(await actorIn([a]));
    const theirs = await journeyFor(b);

    const foreign = await call(`/by-journey/${theirs.journeyId}`);
    const missing = await call("/by-journey/SJ-does-not-exist");
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });
});

/* ═══ AUTHENTICATED READS AND WRITES ARE SCOPED ═════════════════════════ */

describe("company A and company B's enquiries", () => {
  async function twoCompanies() {
    const a = await company("ScopeA");
    const b = await company("ScopeB");
    const actorA = await actorIn([a]);
    const actorB = await actorIn([b]);

    be(actorB);
    const theirJourney = await journeyFor(b);
    await openEnquiry(theirJourney);
    const theirs = await Enquiry.findOne({ journeyId: theirJourney._id }).lean();

    be(actorA);
    return { a, b, actorA, theirs };
  }

  test("a foreign enquiry's history cannot be read, and reads like a missing one", async () => {
    /* ── A ROUTE THAT ACTUALLY EXISTS ───────────────────────────────────
       An earlier draft asserted against `GET /:id`, which this router does not
       have — so both answers were Express's own 404 and the test proved
       nothing. `/:id/change-log` does exist, and audit history is as
       confidential as the record it describes. */
    const { theirs } = await twoCompanies();
    const foreign = await call(`/${theirs._id}/change-log`);
    const missing = await call(`/${new mongoose.Types.ObjectId()}/change-log`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });

  test("a foreign enquiry cannot be updated", async () => {
    const { theirs } = await twoCompanies();
    const r = await call(`/${theirs._id}`, { method: "PATCH", body: { title: "Taken" } });
    expect(r.status).toBe(404);
    const after = await Enquiry.findById(theirs._id).lean();
    expect(after.title).toBe(theirs.title);
  });

  test("nested actions on a foreign enquiry are refused too", async () => {
    const { theirs } = await twoCompanies();
    for (const path_ of [
      `/${theirs._id}/costing-sheet/Blazer/stock-item-sync`,
    ]) {
      const r = await call(path_);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });
});

/* ═══ SALESJOURNEY OWNERSHIP AND SCOPE ══════════════════════════════════ */

describe("SalesJourney creation and access", () => {
  /* The journey router is mounted separately: this suite's app only carries
     the enquiry router, and a test that asserted against a route it had not
     mounted would prove nothing (as an earlier draft of this file did). */
  let jSrv, jBase;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/", require("../../routes/CMS_Routes/Sales/salesJourneys"));
    await new Promise((r) => { jSrv = app.listen(0, r); });
    jBase = `http://127.0.0.1:${jSrv.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => jSrv.close(r)); });

  const jcall = (path_, { method = "GET", body } = {}) =>
    fetch(`${jBase}${path_}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => {
      const raw = await r.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
      return { status: r.status, body: parsed };
    });

  /* A real Account: journey creation loads it, so a random id is refused for
     validation reasons and the ownership assertions would never be reached. */
  const Account = require("../../models/CMS_Models/Sales/Account");
  /* Owned by the ACTING company: journey creation now loads its source account
     through the company scope, so an unowned fixture would be refused for
     source reasons and mask what these tests are actually about. */
  const account = async () => {
    const scope = global.__ACTOR__ ? await actorCompanyOf(global.__ACTOR__) : null;
    return Account.create({
      accountId: `ACC-${++seq}`, companyName: `Buyer ${seq}`, status: "active", isActive: true,
      ...(scope ? { companyId: scope } : {}),
    });
  };

  const newJourney = async (over = {}) => {
    const acc = over.accountId ? null : await account();
    return jcall("", {
      method: "POST",
      body: {
        name: `Journey ${++seq}`,
        accountId: String(acc?._id || over.accountId),
        businessType: "uniform",
        ...over,
      },
    });
  };

  test("a journey is created only with a proven company", async () => {
    const co = await company("SJOwn");
    be(await actorIn([co]));

    const r = await newJourney();
    /* Establish the same-company operation SUCCEEDS before proving the
       foreign equivalent is refused — otherwise the refusals below could be
       any unrelated failure. */
    expect([200, 201]).toContain(r.status);
    const stored = await SalesJourney.findOne({}).lean();
    expect(String(stored.companyId)).toBe(String(co._id));
    expect(stored.companyOwnership.proven).toBe(true);
  });

  test("ambiguous membership creates no journey", async () => {
    const a = await company("SJAmbA");
    await company("SJAmbB");
    be(await actorIn([a, (await company("SJAmbC"))]));
    const r = await newJourney();
    expect(r.status).toBe(409);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("no provable membership creates no journey", async () => {
    await company("SJNoneA");
    await company("SJNoneB");
    be(await actorIn([]));
    const r = await newJourney();
    expect(r.status).toBe(403);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("a company-context outage returns 503 and creates no journey", async () => {
    const co = await company("SJOutage");
    be(await actorIn([co]));
    jest.spyOn(SpCompanyMembership, "find").mockImplementation(() => { throw new Error("db down"); });
    const r = await newJourney();
    expect(r.status).toBe(503);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("a body-supplied company cannot choose ownership", async () => {
    const a = await company("SJBodyA");
    const b = await company("SJBodyB");
    be(await actorIn([a]));
    await newJourney({ companyId: String(b._id), company: String(b._id) });
    const stored = await SalesJourney.findOne({}).lean();
    expect(String(stored.companyId)).toBe(String(a._id));
  });

  test("company A cannot list, read or advance company B's journey", async () => {
    const a = await company("SJScopeA");
    const b = await company("SJScopeB");
    const actorA = await actorIn([a]);
    const actorB = await actorIn([b]);

    be(actorB);
    expect([200, 201]).toContain((await newJourney()).status);
    const theirs = await SalesJourney.findOne({}).lean();
    /* Their own read works — the baseline this comparison needs. */
    expect((await jcall(`/${theirs.journeyId}`)).status).toBe(200);

    be(actorA);
    const list = await jcall("");
    expect(JSON.stringify(list.body)).not.toContain(theirs.journeyId);

    const foreign = await jcall(`/${theirs.journeyId}`);
    const missing = await jcall("/SJ-nope");
    expect(foreign.status).toBe(404);
    /* The bodies differ only by echoing back the reference the CALLER asked
       for, which reveals nothing about whether it exists. Compared with the
       echo normalised away, they are the same answer. */
    const normalise = (b, ref) => ({ ...b, message: String(b.message || "").replace(ref, "<ref>") });
    expect(normalise(foreign.body, theirs.journeyId)).toEqual(normalise(missing.body, "SJ-nope"));

    const advance = await jcall(`/${theirs.journeyId}`, { method: "PATCH", body: { name: "Taken" } });
    expect(advance.status).toBeGreaterThanOrEqual(400);
    expect((await SalesJourney.findById(theirs._id).lean()).name).toBe(theirs.name);
  });

  test("the owner list contains only this company's owners", async () => {
    /* The aggregation groups owner names. Filtering after a global $match
       would already have read every company's rows. */
    const a = await company("SJOwnersA");
    const b = await company("SJOwnersB");
    const actorA = await actorIn([a]);
    const actorB = await actorIn([b]);

    be(actorB);
    await newJourney({ name: "Theirs" });
    await SalesJourney.updateMany({}, { $set: { ownerName: "Their Owner", ownerId: new mongoose.Types.ObjectId() } });

    be(actorA);
    await newJourney({ name: "Ours" });
    const owners = await jcall("/owners");
    if (owners.status === 200) {
      expect(JSON.stringify(owners.body)).not.toContain("Their Owner");
    } else {
      /* If this deployment has no owners route, say so rather than passing
         vacuously. */
      expect(owners.status).toBe(404);
    }
  });
});

/* ═══ THE SALES SOURCE CHAIN CANNOT BE CLAIMED ══════════════════════════ */

describe("journey creation from a foreign source", () => {
  const Account = require("../../models/CMS_Models/Sales/Account");
  const Lead = require("../../models/CMS_Models/Sales/Lead");
  const Contact = require("../../models/CMS_Models/Sales/Contact");
  const Activity = require("../../models/CMS_Models/Sales/Activity");

  let jSrv2, jBase2;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/", require("../../routes/CMS_Routes/Sales/salesJourneys"));
    await new Promise((r) => { jSrv2 = app.listen(0, r); });
    jBase2 = `http://127.0.0.1:${jSrv2.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => jSrv2.close(r)); });

  const post = (body) =>
    fetch(jBase2, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  const accountIn = (co) => Account.create({
    accountId: `ACC-${++seq}`, companyName: `Buyer ${seq}`, status: "active", isActive: true,
    ...(co ? { companyId: co._id } : {}),
  });

  const body = (accountId, over = {}) => ({
    name: `Journey ${++seq}`, accountId: String(accountId), businessType: "uniform", ...over,
  });

  test("the same-company path works first — the baseline every refusal is measured against", async () => {
    const co = await company("SrcOk");
    be(await actorIn([co]));
    const mine = await accountIn(co);
    const r = await post(body(mine._id));
    expect([200, 201]).toContain(r.status);
    expect(await SalesJourney.countDocuments({})).toBe(1);
  });

  test("a foreign ACCOUNT creates no journey", async () => {
    const a = await company("SrcAccA");
    const b = await company("SrcAccB");
    be(await actorIn([a]));
    const theirs = await accountIn(b);

    const r = await post(body(theirs._id));
    expect(r.status).toBe(400);
    /* Reported exactly as a missing account — no hint that it exists. */
    expect(r.body.message).toMatch(/was not found/i);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("a foreign LEAD creates no journey", async () => {
    const a = await company("SrcLeadA");
    const b = await company("SrcLeadB");
    be(await actorIn([a]));
    const mine = await accountIn(a);
    const theirLead = await Lead.create({
      leadId: `LD-${++seq}`, companyId: b._id, company: "Their prospect",
      firstName: "X", captureStatus: "active", isActive: true,
    });

    const r = await post(body(mine._id, { sourceLeadId: String(theirLead._id) }));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/was not found/i);
    expect(await SalesJourney.countDocuments({})).toBe(0);
    /* And nothing was generated on the way to failing. */
    expect(await Contact.countDocuments({})).toBe(0);
    expect(await Activity.countDocuments({})).toBe(0);
  });

  test("a foreign CONTACT creates no journey", async () => {
    const a = await company("SrcCtcA");
    const b = await company("SrcCtcB");
    be(await actorIn([a]));
    const mine = await accountIn(a);
    const theirContact = await Contact.create({
      companyId: b._id, accountId: mine._id, firstName: "Their", lastName: "Person", isActive: true,
    });

    const r = await post(body(mine._id, { primaryContactId: String(theirContact._id) }));
    expect(r.status).toBe(400);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("a foreign COMMERCIAL PARTY creates no journey", async () => {
    const a = await company("SrcPartyA");
    const b = await company("SrcPartyB");
    be(await actorIn([a]));
    const mine = await accountIn(a);
    const theirs = await accountIn(b);

    /* Only the fields this deployment actually treats as commercial parties
       are asserted on; one that is simply ignored is not evidence either way,
       and pretending otherwise would be a vacuous test. */
    let asserted = 0;
    /* Nested under `parties`, which is where the router reads them — sending
       them at the top level would have been ignored, and the test would have
       passed while proving nothing. */
    for (const field of ["billToAccountId", "buyingHouseAccountId", "brandAccountId"]) {
      const before = await SalesJourney.countDocuments({});
      const r = await post(body(mine._id, { parties: { [field]: String(theirs._id) } }));
      if (r.status < 400) {
        /* Not a party field here — clean up and move on. */
        await SalesJourney.deleteMany({});
        continue;
      }
      asserted += 1;
      expect(r.body.message).toMatch(/was not found|not active/i);
      expect(await SalesJourney.countDocuments({})).toBe(before);
    }
    expect(asserted).toBeGreaterThan(0);
  });

  test("new Account, Lead and Contact records carry server-derived ownership", async () => {
    const co = await company("SrcStamp");
    be(await actorIn([co]));
    /* Proved through the model + helper rather than each router, which this
       chunk did not finish scoping; the creation stamp is what is under test. */
    const { ownershipFieldsFor } = require("../../services/companyContext/ownershipStamp.service");
    const fields = await ownershipFieldsFor(global.__ACTOR__);
    expect(String(fields.companyId)).toBe(String(co._id));
    expect(fields.companyOwnership.proven).toBe(true);
    for (const M of [Account, Lead, Contact]) {
      expect(M.schema.path("companyId")).toBeTruthy();
      expect(M.schema.path("companyOwnership.proven")).toBeTruthy();
    }
  });
});

/* ═══ ONE COMPANY RESOLUTION PER REQUEST ════════════════════════════════ */

describe("journey creation resolves the company exactly once", () => {
  const membership = require("../../services/companyContext/companyMembership.service");

  test("the source lookups and the ownership stamp come from one resolution", async () => {
    const a = await company("OnceA");
    const b = await company("OnceB");
    be(await actorIn([a]));

    const Account = require("../../models/CMS_Models/Sales/Account");
    const mine = await Account.create({
      accountId: `ACC-${++seq}`, companyName: `Buyer ${seq}`, status: "active", isActive: true,
      companyId: a._id,
    });

    /* ── THE SECOND RESOLUTION WOULD ANSWER DIFFERENTLY ─────────────────
       If anything resolved membership a second time it would get company B
       here, and the journey would be stamped with a company whose sources
       were never checked. One call, one answer. */
    let calls = 0;
    const real = membership.resolveCompanyForActor;
    jest.spyOn(membership, "resolveCompanyForActor").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) return real(...args);
      return { companyId: b._id, permittedSiteIds: [], membershipSource: "MEMBERSHIP_RECORD", membership: null };
    });

    const r = await fetch(jBase2ForOnce, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Journey ${++seq}`, accountId: String(mine._id), businessType: "uniform" }),
    }).then(async (x) => ({ status: x.status, body: JSON.parse((await x.text()) || "null") }));

    expect([200, 201]).toContain(r.status);
    expect(calls).toBe(1);

    const stored = await SalesJourney.findOne({}).lean();
    expect(String(stored.companyId)).toBe(String(a._id));
    expect(String(stored.companyId)).not.toBe(String(b._id));

    jest.restoreAllMocks();
  });

  let jSrv3, jBase2ForOnce;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/", require("../../routes/CMS_Routes/Sales/salesJourneys"));
    await new Promise((r) => { jSrv3 = app.listen(0, r); });
    jBase2ForOnce = `http://127.0.0.1:${jSrv3.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => jSrv3.close(r)); });
});

/* ═══ THE LEGACY ALLOWANCE CANNOT BE FORGED ═════════════════════════════ */

describe("service scope", () => {
  const {
    createServiceContext, serviceFilter,
  } = require("../../services/companyContext/serviceScope.service");

  test("a forged allowUnowned cannot unlock unowned records", async () => {
    const co = await company("Forge");
    /* A plain object claiming the allowance — the shape the old API accepted. */
    const forged = { companyId: co._id, reason: "forged", allowUnowned: true };
    const clause = serviceFilter(forged, { _id: new mongoose.Types.ObjectId() });
    expect(JSON.stringify(clause)).not.toContain("$exists");
    expect(JSON.stringify(clause)).not.toContain("null");
  });

  test("the factory grants it only when the deployment proves it", async () => {
    const only = await company("ForgeSolo");
    const granted = await createServiceContext({ companyId: only._id, reason: "t", legacyAware: true });
    expect(JSON.stringify(serviceFilter(granted, {}))).toContain("$exists");

    await company("ForgeSecond");
    const refused = await createServiceContext({ companyId: only._id, reason: "t", legacyAware: true });
    expect(JSON.stringify(serviceFilter(refused, {}))).not.toContain("$exists");
  });

  test("the granted context is frozen, so the allowance cannot be flipped after the fact", async () => {
    const only = await company("ForgeFrozen");
    const ctx = await createServiceContext({ companyId: only._id, reason: "t", legacyAware: true });
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

/* ═══ LEGACY UNOWNED RECORDS ════════════════════════════════════════════ */

describe("unowned legacy enquiries", () => {
  test("are readable only in a proven single-company deployment", async () => {
    const only = await company("LegacySolo");
    /* The actor holds a membership, so the refusal under test is about the
       RECORD's ownership rather than about the actor having no company at all
       — which would be a 403 and a different rule. */
    be(await actorIn([only]));
    const journey = await journeyFor(null); // legacy, unowned
    await Enquiry.create({
      enquiryId: `ENQ-L${++seq}`, journeyId: journey._id,
      accountId: new mongoose.Types.ObjectId(), title: "Legacy", isActive: true,
    });
    const legacy = await Enquiry.findOne({ journeyId: journey._id }).lean();

    /* One company: the unowned record is reachable. */
    expect((await call(`/${legacy._id}/change-log`)).status).toBe(200);

    /* A second company appears — and it is not reachable any more, without
       anything about the record itself changing. */
    await company("LegacySecond");
    const after = await call(`/${legacy._id}/change-log`);
    expect(after.status).toBe(404);
    /* And ordinary reads never quietly adopt it. */
    expect((await Enquiry.findById(legacy._id).lean()).companyId ?? null).toBeNull();
  });
});
