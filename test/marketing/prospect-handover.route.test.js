// test/marketing/prospect-handover.route.test.js
//
// THE MARKETING-TO-SALES PROSPECT HANDOVER, END TO END.
//
// Both applications are mounted on one bare Express app — Marketing's door and
// Sales' door — with the two auth middlewares mocked to an `x-test-user`
// header, real Mongoose, and a real company so the shared company resolver's
// single-company-deployment path applies. Everything else is the production
// code path: the real contract, the real assessment, the real outbox, the real
// delivery services and the real Lead model.
//
// The suite is arranged around the nine questions this slice has to answer,
// and the last of them is the one the whole boundary exists for: a marketing
// handover must never produce an Active Lead, an Enquiry or a Sales Journey.
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

process.env.MAUTIC_WEBHOOK_SECRET = "test-webhook-secret";

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["sales", "admin", "ceo"].includes(user.role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["sales", "admin", "ceo"];
  return mw;
});

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const AcquisitionHold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const {
  MarketingIntentEvent, MarketingOutboxEvent, MarketingAuditEvent,
} = require("../../models/CMS_Models/Marketing/MarketingEvent");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const {
  MarketingHandoverReceipt, SalesMarketingOutcomeOutboxEvent,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const { _resetSequence: resetLeadRef } = require("../../services/leadRef");
const { _resetSequence: resetHandoverRef } = require("../../services/marketing/prospectHandover.service");
const discovery = require("../../services/marketing/discoveryProvider.service");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Nikhil Bose", role: "marketing", email: "nikhil@grav.in" };
const SELLER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@grav.in" };
const OTHER_SELLER = { id: new mongoose.Types.ObjectId().toString(), name: "Deepak Nair", role: "sales", email: "deepak@grav.in" };
const STOREKEEPER = { id: new mongoose.Types.ObjectId().toString(), name: "Ravi Kumar", role: "store", email: "ravi@grav.in" };

let server;
let base;
let company;

/* ── MOUNTED THE WAY server.js MOUNTS IT ────────────────────────────────────
   The global `express.json({ verify })` is included deliberately. It is what
   server.js installs at line 156, it consumes the request stream before any
   router sees it, and a webhook that only handled a standalone mount would
   verify a signature against "[object Object]" in production while passing
   every test. Mounting it here is the regression test. */
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "50mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingHandovers"));
  app.use("/api/cms/sales/marketing-handovers", require("../../routes/CMS_Routes/Sales/marketingHandovers"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* The same router with nothing in front of it — a standalone marketing
   process, or a test harness that forgot the global parser. Both mountings
   must verify against the same bytes. */
let bareServer;
let bareBase;

beforeAll(async () => {
  const app = express();
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingHandovers"));
  await new Promise((resolve) => { bareServer = app.listen(0, resolve); });
  bareBase = `http://127.0.0.1:${bareServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => bareServer.close(resolve));
});

beforeEach(async () => {
  await resetLeadRef(new Date().getFullYear());
  await resetHandoverRef(new Date().getFullYear());
  company = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  process.env.MARKETING_COMPANY_ID = String(company._id);
});

async function call(path, { method = "GET", body, user, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

/** A signed Mautic webhook, exactly as the production path verifies it. */
async function webhook(payload, { secret = process.env.MAUTIC_WEBHOOK_SECRET, origin } = {}) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("hex");
  const res = await fetch(`${origin || base}/api/cms/marketing/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mautic-signature": `sha256=${sig}` },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

const PERSON = {
  firstName: "Meera",
  lastName: "Sharma",
  jobTitle: "Head of Procurement",
  workEmail: "meera@aurorahotels.in",
  workPhone: "9876500011",
};

const SUBMISSION = {
  company: {
    name: "Aurora Hotels Pvt Ltd",
    website: "https://aurorahotels.in",
    industry: "hospitality",
    sizeBand: "201-500",
    country: "India",
  },
  person: PERSON,
  marketing: {
    source: "landing_page",
    campaignName: "Hotel Uniform Refresh 2026",
    campaignId: "camp-77",
    assetName: "housekeeping-uniform-guide.pdf",
  },
  permission: {
    emailConsent: "opted_in",
    capturedAt: "2026-08-20T09:00:00.000Z",
    capturedSource: "landing page form",
    noticeVersion: "v3",
  },
  topicsOfInterest: ["housekeeping uniforms"],
};

const sampleRequest = (id = "evt-sample-1", at = new Date().toISOString()) => ({
  sourceEventId: id,
  kind: "sample_requested",
  email: PERSON.workEmail,
  externalContactId: "mautic-4411",
  campaignId: "camp-77",
  campaignName: "Hotel Uniform Refresh 2026",
  assetName: "housekeeping-uniform-guide.pdf",
  topics: ["housekeeping uniforms"],
  occurredAt: at,
});

/** Record evidence, then submit — the ordinary path. */
async function handOver(overrides = {}, eventId = "evt-sample-1") {
  await webhook(sampleRequest(eventId));
  return call("/api/cms/marketing/handovers", {
    method: "POST",
    user: MARKETER,
    body: { ...SUBMISSION, ...overrides },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. A HANDOVER CREATES ONE AWAITING-REVIEW PROSPECT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Marketing submits a handover", () => {
  test("creates exactly one awaiting-review Prospect with the whole package", async () => {
    const res = await handOver();
    expect(res.status).toBe(201);
    expect(res.body.blocked).toBe(false);
    expect(res.body.handover.state).toBe("AWAITING_REVIEW");
    expect(res.body.handover.handoverRef).toMatch(/^MHO-\d{4}-\d{4}$/);
    expect(res.body.delivery).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });

    const leads = await Lead.find({});
    expect(leads).toHaveLength(1);
    const lead = leads[0];

    /* A PROSPECT, and only a Prospect. */
    expect(lead.captureStatus).toBe("draft");
    expect(lead.reviewStatus).toBe("researching");
    expect(lead.qualificationState).toBe("new");

    /* Company, website, person and work contact details. */
    expect(lead.company).toBe("Aurora Hotels Pvt Ltd");
    expect(lead.website).toBe("https://aurorahotels.in");
    expect(lead.firstName).toBe("Meera");
    expect(lead.lastName).toBe("Sharma");
    expect(lead.designation).toBe("Head of Procurement");
    expect(lead.email).toBe("meera@aurorahotels.in");
    expect(lead.phone).toBe("9876500011");
    expect(lead.contacts[0].isPrimary).toBe(true);

    /* Source and campaign. */
    expect(lead.source).toBe("marketing_campaign");
    expect(lead.sourceDetails).toBe("landing_page");
    expect(lead.campaignOrEvent).toBe("Hotel Uniform Refresh 2026");

    /* Permission, assessments, reason and recommended action, on the record. */
    expect(lead.marketingHandover.handoverRef).toBe(res.body.handover.handoverRef);
    expect(lead.marketingHandover.emailConsent).toBe("opted_in");
    expect(lead.marketingHandover.accountFit).toBe("strong");
    expect(lead.marketingHandover.intent).toBe("explicit_request");
    expect(lead.marketingHandover.recommendedAction).toBe("call_within_one_business_day");
    expect(lead.marketingHandover.handoverReason).toContain("asked for a sample");
    expect(lead.interestSignal).toBe("requested_sample");

    /* Activities with timestamps, topics, and duplicate-matching identifiers,
       on the Sales receipt. */
    const receipt = await MarketingHandoverReceipt.findOne({});
    expect(receipt.intakeOutcome).toBe("CREATED");
    expect(String(receipt.leadId)).toBe(String(lead._id));
    expect(receipt.package.activities).toHaveLength(1);
    expect(receipt.package.activities[0].kind).toBe("sample_requested");
    expect(receipt.package.activities[0].occurredAt).toBeInstanceOf(Date);
    expect(receipt.package.topicsOfInterest).toEqual(["housekeeping uniforms"]);
    expect(receipt.package.matchKeys.normalizedEmail).toBe("meera@aurorahotels.in");
    expect(receipt.package.matchKeys.normalizedPhone).toBe("9876500011");
    expect(receipt.package.matchKeys.companyDomain).toBe("aurorahotels.in");
    expect(receipt.decision).toBeUndefined();
  });

  test("carries data-provider provenance when the person was enriched", async () => {
    discovery.registerProvider("testprovider", {
      lookup: async () => ({
        providerRecordId: "zp-991",
        sizeBand: "201-500",
        industry: "hospitality",
        jobTitle: "Head of Procurement",
      }),
    });
    const enrichment = await discovery.enrich({ provider: "testprovider", domain: "aurorahotels.in" });
    discovery.unregisterProvider("testprovider");

    const res = await handOver({ provenance: [enrichment.provenance] });
    expect(res.status).toBe(201);

    const receipt = await MarketingHandoverReceipt.findOne({});
    expect(receipt.package.provenance[0].provider).toBe("testprovider");
    expect(receipt.package.provenance[0].providerRecordId).toBe("zp-991");
    expect(receipt.package.provenance[0].fields).toEqual(
      expect.arrayContaining(["sizeBand", "industry", "jobTitle"]),
    );
    const lead = await Lead.findOne({});
    expect(lead.marketingHandover.dataProviders).toEqual(["testprovider"]);
  });

  test("a discovery provider may not assert marketing permission", async () => {
    discovery.registerProvider("pushyprovider", {
      lookup: async () => ({ industry: "hospitality", emailConsent: "opted_in" }),
    });
    await expect(discovery.enrich({ provider: "pushyprovider", domain: "x.in" }))
      .rejects.toMatchObject({ status: 400 });
    discovery.unregisterProvider("pushyprovider");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. REPEATED EVENTS AND REPEATED DELIVERIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Repeated events cannot create duplicate Prospects", () => {
  test("the same Mautic event delivered twice is recorded once", async () => {
    const first = await webhook(sampleRequest("evt-replay-1"));
    const second = await webhook(sampleRequest("evt-replay-1"));
    expect(first.body).toMatchObject({ recorded: 1, duplicates: 0 });
    expect(second.body).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });

  test("submitting the same handover twice returns the first one and creates one Prospect", async () => {
    const first = await handOver({}, "evt-idem-1");
    const second = await call("/api/cms/marketing/handovers", {
      method: "POST", user: MARKETER, body: SUBMISSION,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.handover.handoverRef).toBe(first.body.handover.handoverRef);

    expect(await Handover.countDocuments({})).toBe(1);
    expect(await Lead.countDocuments({})).toBe(1);
    expect(await MarketingHandoverReceipt.countDocuments({})).toBe(1);
  });

  test("redelivering the same handover event changes nothing", async () => {
    const res = await handOver({}, "evt-redeliver-1");
    const ref = res.body.handover.handoverRef;

    /* Force the announcement back to PENDING and drain it again — exactly what
       a retry sweep does after a delivery that appeared to fail. */
    await MarketingOutboxEvent.updateMany({}, { $set: { status: "PENDING" } });
    const again = await call("/api/cms/marketing/handovers/deliver-pending", {
      method: "POST", user: MARKETER, body: {},
    });

    expect(again.body.summary).toMatchObject({ attempted: 1, duplicates: 1, delivered: 0, failed: 0 });
    expect(await Lead.countDocuments({ "marketingHandover.handoverRef": ref })).toBe(1);
    expect(await MarketingHandoverReceipt.countDocuments({})).toBe(1);
  });

  test("a second Lead carrying the same handover reference is refused by the database", async () => {
    const res = await handOver({}, "evt-index-1");
    const ref = res.body.handover.handoverRef;
    await Lead.syncIndexes();

    await expect(Lead.create({
      leadId: "LEAD-9999-0001",
      companyId: company._id,
      company: "Aurora Hotels Pvt Ltd",
      captureStatus: "draft",
      marketingHandover: { handoverRef: ref },
    })).rejects.toMatchObject({ code: 11000 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. MATCHING AN EXISTING PERSON OR COMPANY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("An existing Sales record is linked, not duplicated", () => {
  test("a person Sales already holds is linked and no Prospect is created", async () => {
    const existing = await Lead.create({
      leadId: "LEAD-2026-9001",
      companyId: company._id,
      company: "Aurora Hotels Pvt Ltd",
      firstName: "Meera",
      lastName: "Sharma",
      email: PERSON.workEmail,
      captureStatus: "active",
      isActive: true,
    });

    const res = await handOver({}, "evt-match-1");
    expect(res.status).toBe(201);

    /* No new Prospect. The one Lead in the database is the pre-existing one. */
    const leads = await Lead.find({});
    expect(leads).toHaveLength(1);
    expect(String(leads[0]._id)).toBe(String(existing._id));
    expect(leads[0].marketingHandover?.handoverRef).toBeUndefined();

    const receipt = await MarketingHandoverReceipt.findOne({});
    expect(receipt.intakeOutcome).toBe("LINKED");
    expect(String(receipt.linkedRecordId)).toBe(String(existing._id));
    expect(receipt.linkedRecordType).toBe("lead");
  });

  test("a shared company name alone does not link — two people at one buyer are two prospects", async () => {
    await Account.create({
      companyId: company._id,
      companyName: "Aurora Hotels Pvt Ltd",
      website: "https://aurorahotels.in",
      status: "active",
    });

    const res = await handOver({}, "evt-match-2");
    expect(res.status).toBe(201);

    const receipt = await MarketingHandoverReceipt.findOne({});
    expect(receipt.intakeOutcome).toBe("CREATED");
    /* The account still surfaces as a candidate for a salesperson to see. */
    expect(receipt.duplicateCandidates.some((m) => m.recordType === "account")).toBe(true);
    expect(await Lead.countDocuments({ captureStatus: "draft" })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. MISSING OR INVALID DATA
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Missing or invalid data is refused by name", () => {
  /* The campaign cases send a campaign-less EVENT too. A submission that omits
     the campaign name but whose evidence carries one is not missing data —
     `preparePackage` fills it from the ledger on purpose, so a marketer never
     has to retype what Mautic already said. The refusal is for the case where
     neither the submission nor the evidence names a campaign. */
  const cases = [
    ["no organisation", { company: { name: "" } }, "organisation's name", {}],
    ["no person", { person: { ...PERSON, firstName: "" } }, "first name", {}],
    ["no work contact", { person: { ...PERSON, workEmail: "", workPhone: "" } }, "work email address or a work phone", {}],
    ["a malformed work email", { person: { ...PERSON, workEmail: "meera-at-aurora" } }, "not a valid address", {}],
    ["no campaign anywhere", { marketing: { source: "landing_page", campaignName: "" } }, "campaign", { campaignName: "" }],
    ["no marketing source", { marketing: { source: "", campaignName: "X" } }, "marketing source", {}],
    ["an unknown permission state", { permission: { emailConsent: "maybe" } }, "not a marketing permission state", {}],
  ];

  test.each(cases)("refuses a handover with %s", async (_label, override, message, eventOverride) => {
    await webhook({ ...sampleRequest("evt-invalid-" + Math.random()), ...eventOverride });
    const res = await call("/api/cms/marketing/handovers", {
      method: "POST", user: MARKETER, body: { ...SUBMISSION, ...override },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Handover.countDocuments({})).toBe(0);
  });

  test("an opted-out person is blocked before Sales ever sees them", async () => {
    const res = await handOver({ permission: { emailConsent: "opted_out" } }, "evt-consent-1");
    expect(res.status).toBe(201);
    expect(res.body.blocked).toBe(true);
    expect(res.body.reason).toContain("opted_out");
    expect(res.body.handover.state).toBe("BLOCKED");

    /* Recorded, so Marketing can answer "why did that campaign produce
       nothing" — but never delivered and never a Prospect. */
    expect(await MarketingOutboxEvent.countDocuments({})).toBe(0);
    expect(await MarketingHandoverReceipt.countDocuments({})).toBe(0);
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("a suppressed person is blocked whatever their consent says", async () => {
    const res = await handOver(
      { permission: { emailConsent: "opted_in", suppressed: true } }, "evt-consent-2",
    );
    expect(res.body.blocked).toBe(true);
    expect(res.body.reason).toContain("suppressed");
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("an open and a page view are not enough to hand anybody over", async () => {
    await webhook({ ...sampleRequest("evt-weak-1"), kind: "email_opened" });
    await webhook({ ...sampleRequest("evt-weak-2"), kind: "page_viewed" });
    const res = await call("/api/cms/marketing/handovers", {
      method: "POST", user: MARKETER, body: SUBMISSION,
    });

    expect(res.body.blocked).toBe(true);
    expect(res.body.reason).toContain("not enough");
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("two meaningful engagements clear the threshold without an explicit ask", async () => {
    await webhook({ ...sampleRequest("evt-eng-1"), kind: "email_clicked" });
    await webhook({ ...sampleRequest("evt-eng-2"), kind: "email_clicked" });
    const res = await call("/api/cms/marketing/handovers", {
      method: "POST", user: MARKETER, body: SUBMISSION,
    });

    expect(res.body.blocked).toBe(false);
    const lead = await Lead.findOne({});
    expect(lead.marketingHandover.intent).toBe("moderate");
    /* No explicit ask, so no interest SIGNAL is invented for Sales. */
    expect(lead.interestSignal).toBeUndefined();
  });

  test("an unknown event kind is rejected without being retried for ever", async () => {
    const res = await webhook({ ...sampleRequest("evt-unknown-1"), kind: "telepathy" });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0].reason).toContain("not a marketing event");
    expect(await MarketingIntentEvent.countDocuments({})).toBe(0);
  });

  test("an event with no source id is refused — it could never be deduplicated", async () => {
    const res = await webhook({ ...sampleRequest(""), sourceEventId: "" });
    expect(res.body.rejected[0].reason).toContain("source system's own event id");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. UNAUTHORIZED REQUESTS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("The integration refuses unauthorized callers", () => {
  test("an unsigned webhook is refused", async () => {
    const res = await fetch(`${base}/api/cms/marketing/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleRequest("evt-unsigned-1")),
    });
    expect(res.status).toBe(401);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(0);
  });

  test("a webhook signed with the wrong secret is refused", async () => {
    const res = await webhook(sampleRequest("evt-badsig-1"), { secret: "not-the-secret" });
    expect(res.status).toBe(401);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(0);
  });

  test("a webhook whose body was altered after signing is refused", async () => {
    const payload = sampleRequest("evt-tamper-1");
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", process.env.MAUTIC_WEBHOOK_SECRET)
      .update(Buffer.from(raw, "utf8")).digest("hex");
    const res = await fetch(`${base}/api/cms/marketing/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mautic-signature": `sha256=${sig}` },
      body: JSON.stringify({ ...payload, kind: "quotation_requested" }),
    });
    expect(res.status).toBe(401);
  });

  test("the signature is verified under both mountings, global parser or not", async () => {
    const signed = await webhook(sampleRequest("evt-bare-1"), { origin: bareBase });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ recorded: 1 });

    const forged = await webhook(sampleRequest("evt-bare-2"), { origin: bareBase, secret: "wrong" });
    expect(forged.status).toBe(401);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });

  test("submitting a handover with no session is refused", async () => {
    const res = await call("/api/cms/marketing/handovers", { method: "POST", body: SUBMISSION });
    expect(res.status).toBe(401);
  });

  test("a non-marketing role cannot submit a handover", async () => {
    const res = await call("/api/cms/marketing/handovers", {
      method: "POST", user: STOREKEEPER, body: SUBMISSION,
    });
    expect(res.status).toBe(403);
  });

  test("a marketer cannot reach the Sales handover inbox or decide anything", async () => {
    await handOver({}, "evt-authz-1");
    const ref = (await MarketingHandoverReceipt.findOne({})).handoverRef;

    expect((await call("/api/cms/sales/marketing-handovers", { user: MARKETER })).status).toBe(403);
    const decided = await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, {
      method: "POST", user: MARKETER, body: {},
    });
    expect(decided.status).toBe(403);
    expect((await MarketingHandoverReceipt.findOne({})).decision).toBeUndefined();
  });

  test("a salesperson cannot assign a handover to somebody else", async () => {
    await handOver({}, "evt-authz-2");
    const ref = (await MarketingHandoverReceipt.findOne({})).handoverRef;

    const res = await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, {
      method: "POST", user: SELLER, body: { assignTo: OTHER_SELLER.id, assignToName: OTHER_SELLER.name },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("Sales manager");
    expect((await MarketingHandoverReceipt.findOne({})).decision).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6-8. THE SALES DECISION, AND THE FEEDBACK THAT FOLLOWS IT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Sales decides, and Marketing is told", () => {
  let ref;

  beforeEach(async () => {
    await handOver({}, "evt-decide-" + Math.random());
    ref = (await MarketingHandoverReceipt.findOne({})).handoverRef;
  });

  test("the inbox shows the handover awaiting review", async () => {
    const res = await call("/api/cms/sales/marketing-handovers", { user: SELLER });
    expect(res.status).toBe(200);
    expect(res.body.handovers).toHaveLength(1);
    expect(res.body.handovers[0].handoverRef).toBe(ref);
    expect(res.body.handovers[0].package.assessment.handoverReason).toContain("Aurora Hotels");
  });

  test("accepting assigns the Prospect and leaves it a Prospect", async () => {
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, {
      method: "POST", user: SELLER, body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.handover.decision).toBe("ACCEPTED");

    const lead = await Lead.findOne({});
    expect(String(lead.assignedTo)).toBe(SELLER.id);
    expect(lead.assignedToName).toBe(SELLER.name);
    /* STILL A PROSPECT. Accepting is not promoting. */
    expect(lead.captureStatus).toBe("draft");
    expect(lead.reviewStatus).toBe("researching");
    expect(lead.qualificationState).toBe("new");
  });

  test("acceptance reaches Marketing and REQUESTS an acquisition pause rather than claiming one", async () => {
    await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, {
      method: "POST", user: SELLER, body: {},
    });

    const handover = await Handover.findOne({ handoverRef: ref });
    expect(handover.state).toBe("ACCEPTED");
    expect(handover.outcome.decision).toBe("ACCEPTED");
    expect(handover.outcome.salesRecordRef).toMatch(/^LEAD-/);

    /* ── THE CORRECTION THIS ASSERTION CARRIES ──────────────────────────
       This used to expect a Date here, written in the same save as the
       decision while nothing in Mautic had happened. There is no Mautic in
       this suite, so the stop cannot have been carried out — and the honest
       answer is therefore an EMPTY timestamp beside a recorded command that
       says why. */
    expect(handover.permission.acquisitionPausedAt).toBeNull();

    const hold = await AcquisitionHold.findOne({ handoverRef: ref });
    expect(hold.reason).toBe("SALES_ACCEPTED");
    expect(hold.state).toBe("FAILED");
    expect(hold.confirmedAt).toBeNull();
    /* This suite registers no acquisition scope, so the hold refuses before it
       touches Mautic at all. That is the correction: without a registered
       scope GRAV cannot tell acquisition from transactional, service or
       Sales-assisted nurture automation, so it removes nothing. */
    expect(hold.activeError.reasonCode).toBe("ACQUISITION_SCOPE_MISSING");
    expect(hold.activeError.failureClass).toBe("TERMINAL");

    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ status: "PENDING" })).toBe(0);
    const trail = await MarketingAuditEvent.find({ handoverRef: ref }).sort({ at: 1 }).lean();
    expect(trail.map((t) => t.action)).toEqual([
      "handover.submitted", "handover.accepted", "handover.acquisition_hold.failed",
    ]);
  });

  test("returning for nurture archives the Prospect and tells Marketing what to nurture", async () => {
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}/return`, {
      method: "POST",
      user: SELLER,
      body: {
        reason: "Budget cycle starts in April; too early to call.",
        nurtureTopic: "housekeeping fabric durability",
        revisitAt: "2027-03-01T00:00:00.000Z",
      },
    });
    expect(res.status).toBe(200);

    const lead = await Lead.findOne({});
    expect(lead.captureStatus).toBe("archived");
    expect(lead.draftArchivedAt).toBeInstanceOf(Date);
    /* The HOD review axis is untouched — no HOD saw this. */
    expect(lead.reviewStatus).toBe("researching");

    const handover = await Handover.findOne({ handoverRef: ref });
    expect(handover.state).toBe("RETURNED");
    expect(handover.outcome.nurtureTopic).toBe("housekeeping fabric durability");
    expect(handover.outcome.revisitAt).toBeInstanceOf(Date);
    /* A return does NOT pause acquisition — it asks Marketing to carry on. No
       command is raised at all, so there is nothing to retry and nothing that
       could later resume acquisition by itself. */
    expect(handover.permission.acquisitionPausedAt).toBeNull();
    expect(await AcquisitionHold.countDocuments({ handoverRef: ref })).toBe(0);
  });

  test("returning without a reason is refused — Marketing acts on it", async () => {
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}/return`, {
      method: "POST", user: SELLER, body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("reason is required");
    expect((await Lead.findOne({})).captureStatus).toBe("draft");
  });

  test("rejecting archives the Prospect and reaches Marketing with the reason", async () => {
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}/reject`, {
      method: "POST", user: SELLER, body: { reason: "Student project, not a buyer." },
    });
    expect(res.status).toBe(200);

    expect((await Lead.findOne({})).captureStatus).toBe("archived");
    const handover = await Handover.findOne({ handoverRef: ref });
    expect(handover.state).toBe("REJECTED");
    expect(handover.outcome.reason).toBe("Student project, not a buyer.");
  });

  test("linking a duplicate archives the created Prospect and points Marketing at the real record", async () => {
    const real = await Lead.create({
      leadId: "LEAD-2026-8001",
      companyId: company._id,
      company: "Aurora Hotels Pvt Ltd",
      firstName: "Meera",
      captureStatus: "active",
      isActive: true,
    });

    const res = await call(`/api/cms/sales/marketing-handovers/${ref}/link-duplicate`, {
      method: "POST",
      user: SELLER,
      body: { reason: "Same buyer, different address.", duplicateOfType: "lead", duplicateOfId: String(real._id) },
    });
    expect(res.status).toBe(200);

    const handover = await Handover.findOne({ handoverRef: ref });
    expect(handover.state).toBe("DUPLICATE_LINKED");
    expect(String(handover.outcome.salesRecordId)).toBe(String(real._id));
    /* Requested, not claimed — the same correction as on acceptance. */
    expect(handover.permission.acquisitionPausedAt).toBeNull();
    expect((await AcquisitionHold.findOne({ handoverRef: ref })).reason)
      .toBe("SALES_DUPLICATE_LINKED");

    const created = await Lead.findOne({ "marketingHandover.handoverRef": ref });
    expect(created.captureStatus).toBe("archived");
    /* The record Sales already had is untouched. */
    expect((await Lead.findById(real._id)).captureStatus).toBe("active");
  });

  test("a handover can only be decided once", async () => {
    await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, { method: "POST", user: SELLER, body: {} });
    const again = await call(`/api/cms/sales/marketing-handovers/${ref}/reject`, {
      method: "POST", user: SELLER, body: { reason: "changed my mind" },
    });
    expect(again.status).toBe(409);
    expect((await Handover.findOne({ handoverRef: ref })).state).toBe("ACCEPTED");
  });

  test("a redelivered decision does not overwrite the first answer", async () => {
    await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, { method: "POST", user: SELLER, body: {} });
    await SalesMarketingOutcomeOutboxEvent.updateMany({}, { $set: { status: "PENDING" } });

    const outcomeDelivery = require("../../services/integration/marketingOutcomeDelivery.service");
    const summary = await outcomeDelivery.deliverPending({ companyId: company._id });
    expect(summary).toMatchObject({ attempted: 1, duplicates: 1, failed: 0 });

    const trail = await MarketingAuditEvent.find({ handoverRef: ref, action: "handover.accepted" }).lean();
    expect(trail).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. NO MARKETING PATH CREATES AN ACTIVE LEAD OR A PIPELINE RECORD
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Marketing cannot move the Sales lifecycle", () => {
  test("no handover, accepted or not, produces an Active Lead, Enquiry or Journey", async () => {
    await handOver({}, "evt-boundary-1");
    const ref = (await MarketingHandoverReceipt.findOne({})).handoverRef;
    await call(`/api/cms/sales/marketing-handovers/${ref}/accept`, { method: "POST", user: SELLER, body: {} });

    expect(await Lead.countDocuments({ captureStatus: "active" })).toBe(0);
    expect(await Lead.countDocuments({ reviewStatus: "approved" })).toBe(0);
    expect(await Lead.countDocuments({ qualificationState: { $ne: "new" } })).toBe(0);
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
    expect(await Account.countDocuments({})).toBe(0);
    expect(await Activity.countDocuments({})).toBe(0);
  });

  test("the Marketing router exposes no route that writes a Sales record", async () => {
    const layer = require("../../routes/CMS_Routes/Marketing/marketingHandovers");
    const paths = layer.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expect(paths.sort()).toEqual([
      /* Chunk 0 added GET /health. It is a read of Mautic's own state and
         writes nothing anywhere — listed here so that adding a route to this
         router stays a deliberate act with a test to update. */
      "GET /handovers",
      "GET /handovers/:handoverRef",
      "GET /health",
      "POST /events",
      "POST /handovers",
      /* Chunk 3B added this one. It re-drives acquisition-hold commands this
         company already owes against Mautic; it writes no Sales record and asks
         Sales nothing. */
      "POST /handovers/acquisition-holds/retry",
      "POST /handovers/deliver-pending",
      "POST /handovers/preview",
    ]);
  });

  test("the Marketing application never loads a Sales lifecycle writer", async () => {
    /* The structural half of the guarantee: if this ever fails, somebody has
       given Marketing a way to move a Lead, and no amount of route testing
       would have caught it.

       ── NARROWED IN CHUNK 2 ──────────────────────────────────────────────
       This banned importing `Sales/Lead` at all. Chunk 2's Activity projection
       has to READ a Lead — to confirm, within the company, that the record a
       marketing identity claims to be linked to still exists — before attaching
       a timeline entry to it. The rule it was reaching for was never "do not
       import a Lead"; it was "do not MOVE one". That is what is asserted now,
       for every file, plus a whitelist of the one file allowed to read Leads and
       a check that it writes none. */
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "services", "marketing");
    const MAY_READ_LEADS = new Set(["crmActivityProjection.service.js"]);

    /* ── RECURSIVE, BECAUSE A SUBDIRECTORY IS STILL MARKETING ──────────────
       This read the directory flat, so the first subdirectory added under it
       (`channels/`, for the advertising integration) crashed the test rather
       than being checked. A structural guarantee that stops at the first folder
       is a guarantee somebody escapes by making a folder. */
    const walk = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(root, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

    const files = walk(dir).filter((f) => f.endsWith(".js"));
    /* The walk found something. An empty list would pass every assertion below
       and prove nothing. */
    expect(files.length).toBeGreaterThan(20);

    for (const full of files) {
      const file = path.basename(full);
      const src = fs.readFileSync(full, "utf8");
      /* The two single-writer services that move a Lead's lifecycle. */
      expect(src).not.toMatch(/require\([^)]*leadReview/);
      expect(src).not.toMatch(/require\([^)]*leadQualification/);
      /* The pipeline records. */
      expect(src).not.toMatch(/require\([^)]*Sales\/SalesJourney/);
      expect(src).not.toMatch(/require\([^)]*Sales\/Enquiry/);

      if (!MAY_READ_LEADS.has(file)) {
        expect(src).not.toMatch(/require\([^)]*Sales\/Lead/);
      } else {
        /* Reads only. If any of these appear, Marketing has acquired a way to
           change a Lead. */
        expect(src).not.toMatch(/Lead\.(create|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|findByIdAndUpdate|bulkWrite)/);
        expect(src).not.toMatch(/\.save\(\)/);
      }
    }
  });

  test("the Marketing identity mapping is keyed on an opaque key, not an email address", async () => {
    await handOver({}, "evt-identity-1");
    const identity = await MarketingIdentity.findOne({});
    expect(identity.gravPersonKey).toMatch(/^[0-9a-f]{24}$/);
    expect(identity.gravPersonKey).not.toContain("@");
    expect(identity.email).toBe(PERSON.workEmail);
    expect(identity.externals).toEqual(
      expect.arrayContaining([expect.objectContaining({ system: "mautic", externalId: "mautic-4411" })]),
    );
  });
});
