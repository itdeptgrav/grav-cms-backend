// test/marketing/indiamart-sales-handover.test.js
//
// AN INDIAMART BUYER ENQUIRY IN SALES: ITS OWN SOURCE, A VISIBLE QUEUE, AND AN
// ENQUIRY TIME THAT IS READ OR CONFIRMED — NEVER INVENTED.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   A routed IndiaMART enquiry is a Lead with source `indiamart`, keeping its
//   kind, channel and GRAV reference; a campaign handover is unchanged.
//   Every routed enquiry is in the Sales handover queue, readable by any
//   salesperson, with its age and next action — unowned, uncontacted, until
//   somebody accepts it.
//   An unreadable or impossible time is held for a person, who can confirm it
//   with a note; who, when and how are kept, and the source's text is never
//   touched. A valid but old time is a different reason.
//   Duplicate deliveries, missing company, downtime and company isolation.
//   Simulated: the IndiaMART transport is injected.
"use strict";

const mockUser = (allowed) => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  const user = JSON.parse(raw);
  if (!allowed.includes(user.role) && !user.isAdmin) return res.status(403).json({ success: false, message: "Access denied." });
  req.user = user;
  return next();
};
jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => mockUser(["marketing", "admin", "ceo"])(req, res, next);
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => mockUser(["sales", "admin", "ceo"])(req, res, next);
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["sales", "admin", "ceo"];
  return mw;
});
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingSourceEnquiry } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const { MarketingSourceEnquiryRouting } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiryRouting");
const { MarketingLeadSourceState } = require("../../models/CMS_Models/Marketing/MarketingLeadSourceState");
const { MarketingIntentEvent, MarketingOutboxEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const CrmLookup = require("../../models/CMS_Models/Sales/CrmLookup");
const { MarketingHandoverReceipt } = require("../../models/CMS_Models/Sales/MarketingProspectIntake");

const { _resetSequence: resetLeadRef } = require("../../services/leadRef");
const producer = require("../../services/marketing/prospectHandover.service");
const salesIntake = require("../../services/sales/marketingProspectIntake.service");
const delivery = require("../../services/integration/marketingProspectDelivery.service");
const scheduler = require("../../services/integration/indiamartScheduler");
const routing = require("../../services/integration/indiamartSalesRouting.service");
const sync = require("../../services/marketing/leads/indiamartSync.service");
const { LEAD_SOURCES } = require("../../constants/crm");
const I = require("../../constants/marketingIndiamart");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const KEY = "hvT7SECRETindiamartKEYvalue99";
const START = Math.floor(Date.now() / 1000) * 1000;

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo Marketer", role: "marketing" };
const SELLER = { id: new mongoose.Types.ObjectId().toString(), name: "Sal Seller", role: "sales", email: "sal@grav.in" };

let A; let B;
let server; let base;
const clock = { now: START };
const now = () => clock.now;
const later = (ms) => { clock.now += ms; };
const saved = {};

let answers = [];
function transport() {
  const next = answers.shift();
  return Promise.resolve(next || ok([]));
}
const ok = (records) => ({
  status: 200,
  text: JSON.stringify({ CODE: 200, STATUS: "SUCCESS", MESSAGE: "", TOTAL_RECORDS: records.length, RESPONSE: records }),
});
const istText = (ms) => new Date(ms + 5.5 * 60 * MINUTE).toISOString().slice(0, 19).replace("T", " ");

let seq = 0;
const rec = (over = {}) => {
  seq += 1;
  return {
    UNIQUE_QUERY_ID: `4${String(100000000 + seq)}`,
    QUERY_TYPE: "W",
    QUERY_TIME: istText(clock.now - 3 * 60 * MINUTE),
    SENDER_NAME: `Asha ${seq} Menon`,
    SENDER_MOBILE: `+91-97${String(10000000 + seq).slice(-8)}`,
    SENDER_EMAIL: `asha${seq}@garments${seq}.in`,
    SENDER_COMPANY: `Menon Garments ${seq}`,
    SENDER_COUNTRY_ISO: "IN",
    QUERY_PRODUCT_NAME: "Hoodies",
    QUERY_MESSAGE: "Need 300 hoodies.",
    ...over,
  };
};

const cycle = () => scheduler.runCycle({ now, transport, isEnabled: async () => true });
const routeA = () => routing.routeCompany({ companyId: A, now });
const rowFor = async (reason, company = A) => MarketingSourceEnquiryRouting.findOne({ companyId: company, reason }).lean();

async function call(method, p, { user = MARKETER, company = A, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  if (company) headers["x-test-company"] = String(company);
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, body: json, text };
}
const release = (ref, body, opts) => call("POST", `/api/cms/marketing/lead-sources/indiamart/enquiries/${ref}/release`, { body, ...opts });
const salesQueue = (qs = "", opts = {}) => call("GET", `/api/cms/sales/marketing-handovers${qs ? `?${qs}` : ""}`, { user: SELLER, ...opts });

beforeAll(async () => {
  for (const k of ["MARKETING_COMPANY_ID", I.KEY_ENV]) saved[k] = process.env[k];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) {
      const companyId = new mongoose.Types.ObjectId(c);
      req.__marketingCompanyId = companyId;
      req.__salesScope = { companyId, membershipSource: "test", allowUnowned: false, clause: { companyId } };
    }
    next();
  });
  app.locals.marketingIndiamartTransport = transport;
  app.locals.marketingIndiamartClock = now;
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/enquiries"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/leadSources"));
  app.use("/api/cms/sales/marketing-handovers", require("../../routes/CMS_Routes/Sales/marketingHandovers"));
  app.use("/api/cms/crm/lookups", require("../../routes/CMS_Routes/Sales/crmLookups"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  jest.restoreAllMocks();
  await resetLeadRef(new Date().getFullYear());
  await producer._resetSequence(new Date().getFullYear());
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_COMPANY_ID = String(A);
  process.env[I.KEY_ENV] = KEY;
  clock.now = START;
  answers = [];
});

/* ═══ 1. ITS OWN SOURCE ═══════════════════════════════════════════════════ */

describe("the IndiaMART Lead source", () => {
  test("1. a routed enquiry is an `indiamart` Lead, keeping kind, channel, GRAV reference and the time as sent", async () => {
    const r = rec({ QUERY_TYPE: "WA" });
    answers.push(ok([r]));
    await cycle();
    const lead = await Lead.findOne({ companyId: A }).lean();
    const row = await MarketingSourceEnquiryRouting.findOne({ companyId: A }).lean();
    expect(lead.source).toBe("indiamart");
    expect(lead.sourceDetails).toBe("WhatsApp enquiry");
    expect(lead.campaignOrEvent).toBeUndefined();
    expect(lead.marketingHandover.sourceEnquiry).toMatchObject({
      source: "indiamart", sourceRef: row.submissionRef, kind: "buyer_enquiry", channel: "WhatsApp enquiry",
      submittedAtText: r.QUERY_TIME, submittedAtProvenance: "source",
    });
    expect(lead.assignedTo).toBeUndefined();
  });

  test("2. a campaign handover is unchanged: `marketing_campaign`, its source text and campaign, no source enquiry", async () => {
    const lead = salesIntake.leadFromPackage({
      person: { firstName: "C", workEmail: "c@co.in" }, company: { name: "Co" },
      marketing: { sourceSystem: "mautic", source: "landing_page", campaignName: "Autumn samples" },
      activities: [], topicsOfInterest: ["Polos"],
    });
    expect(lead).toMatchObject({ source: "marketing_campaign", sourceDetails: "landing_page", campaignOrEvent: "Autumn samples", possibleNeed: "Interested in Polos." });
    /* A package that merely SAYS indiamart but carries no source enquiry is not one. */
    expect(salesIntake.leadSourceOf({ marketing: { sourceSystem: "indiamart" } })).toBe("marketing_campaign");
    expect(salesIntake.marketingBlock({ handoverRef: "MHO-1", marketing: {}, permission: {}, assessment: {} }).sourceEnquiry).toBeUndefined();
  });

  test("3. the Lead model accepts `indiamart` alongside every earlier code and still refuses an unknown one; lookups serve its label", async () => {
    const codes = Lead.schema.path("source").enumValues;
    expect(codes).toEqual([
      "website", "referral", "cold_call", "trade_show", "social_media", "existing_customer", "advertisement",
      "walk_in", "google", "linkedin", "directory", "field_visit", "marketing_campaign", "indiamart", "other",
    ]);
    expect(new Lead({ source: "indiamart" }).validateSync()?.errors?.source).toBeUndefined();
    expect(new Lead({ source: "india_mart" }).validateSync()?.errors?.source).toBeTruthy();

    const fromConstants = await call("GET", "/api/cms/crm/lookups?category=lead_source", { user: SELLER });
    expect(fromConstants.body.lookups.find((x) => x.code === "indiamart")).toMatchObject({ label: "IndiaMART" });
    /* A collection seeded before this category existed still serves it. */
    await CrmLookup.create({ category: "account_role", code: "buyer", label: "Buyer", sortOrder: 0, isActive: true });
    const seeded = await call("GET", "/api/cms/crm/lookups", { user: SELLER });
    expect(seeded.body.source).toBe("db");
    expect(seeded.body.lookups.lead_source.map((x) => x.code)).toEqual(LEAD_SOURCES.map((x) => x.code));
  });

  test("4. duplicate deliveries: one `indiamart` Lead, however often Sales is told", async () => {
    answers.push(ok([rec()]));
    await cycle();
    for (let i = 0; i < 3; i += 1) await delivery.deliverPending({ companyId: A });
    for (const e of await MarketingOutboxEvent.find({ companyId: A }).lean()) {
      expect((await salesIntake.receive(e, { readHandover: producer.readByRef })).duplicate).toBe(true);
    }
    await routeA();
    const leads = await Lead.find({ companyId: A }).lean();
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("indiamart");
  });
});

/* ═══ 2. THE SALES QUEUE ══════════════════════════════════════════════════ */

describe("the Sales queue", () => {
  test("5. an ordinary salesperson sees each routed enquiry with source, age, next action and no owner", async () => {
    answers.push(ok([rec(), rec({ QUERY_TYPE: "P" })]));
    await cycle();
    later(45 * MINUTE);
    /* The queue computes age against the wall clock; the handover was received at START. */
    const { status, body } = await salesQueue("source=indiamart&order=oldest");
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.summary).toMatchObject({ awaiting: 2, ownershipRule: { automatic: false } });
    expect(body.summary.awaitingBySource.find((s) => s.code === "indiamart").count).toBe(2);
    for (const h of body.handovers) {
      expect(h.queue).toMatchObject({
        source: { code: "indiamart", label: "IndiaMART" },
        sourceEnquiry: { kind: "buyer_enquiry", madeAtProvenance: "source" },
        owner: null,
        ownershipRule: { automatic: false },
        nextAction: { code: "accept_or_answer" },
        contacted: false,
      });
      expect(h.queue.ageMinutes).toBeGreaterThanOrEqual(0);
      expect(h.queue.enquiryAgeMinutes).toBeGreaterThanOrEqual(180);
      expect(h.queue.sourceEnquiry.ref).toMatch(/^MSE-/);
      expect(h.queue.prospectRef).toMatch(/^LEAD-/);
    }
    const t = body.handovers.map((h) => Date.parse(h.queue.waitingSince));
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect((await salesQueue("source=marketing_campaign")).body.total).toBe(0);
    expect((await salesQueue("source=facebook")).status).toBe(400);
    expect((await salesQueue("state=nonsense")).status).toBe(400);
  });

  test("6. accepting takes ownership for the salesperson; it stays a Prospect and nobody is marked contacted", async () => {
    answers.push(ok([rec()]));
    await cycle();
    const [h] = (await salesQueue()).body.handovers;
    const acc = await call("POST", `/api/cms/sales/marketing-handovers/${h.handoverRef}/accept`, { user: SELLER, body: {} });
    expect(acc.status).toBe(200);
    const lead = await Lead.findOne({ companyId: A }).lean();
    expect(String(lead.assignedTo)).toBe(SELLER.id);
    expect(lead.captureStatus).toBe("draft");
    expect(lead.source).toBe("indiamart");
    expect(await Activity.countDocuments({})).toBe(0);
    const one = (await call("GET", `/api/cms/sales/marketing-handovers/${h.handoverRef}`, { user: SELLER })).body.handover.queue;
    expect(one).toMatchObject({ owner: { id: SELLER.id }, nextAction: { code: "first_contact" }, decision: { code: "ACCEPTED" }, contacted: false });
    expect((await salesQueue()).body.summary.awaiting).toBe(0);
  });

  test("7. company isolation: another company's queue shows none of these", async () => {
    answers.push(ok([rec()]));
    await cycle();
    const b = await salesQueue("", { company: B });
    expect(b.body.total).toBe(0);
    expect(b.body.summary.awaiting).toBe(0);
    const ref = (await salesQueue()).body.handovers[0].handoverRef;
    expect((await call("GET", `/api/cms/sales/marketing-handovers/${ref}`, { user: SELLER, company: B })).status).toBe(404);
  });
});

/* ═══ 3. THE ENQUIRY TIME ═════════════════════════════════════════════════ */

describe("the enquiry time", () => {
  test("8. an unreadable time is held; a reviewer confirms it with a note; provenance is kept end to end; the source's text is untouched", async () => {
    answers.push(ok([rec({ QUERY_TIME: "22/09/2026 10:15 AM" })]));
    await cycle();
    const row = await rowFor("submitted_time_unknown");
    expect(row.state).toBe("held_for_review");
    const listed = (await call("GET", "/api/cms/marketing/lead-sources/indiamart/routing")).body.routing[0];
    expect(listed.reason).toMatchObject({ code: "submitted_time_unknown", release: "confirmSubmittedAt" });
    expect(listed.enquiryTime).toEqual({ asSent: "22/09/2026 10:15 AM", readAs: null, confirmed: null, provenance: "none" });

    const ref = row.submissionRef;
    const confirmed = new Date(START - 2 * 60 * MINUTE);
    const at = `${new Date(confirmed.getTime() + 5.5 * 60 * MINUTE).toISOString().slice(0, 19)}+05:30`;
    expect((await release(ref, { submittedAt: at })).status).toBe(400); // no note
    expect((await release(ref, { submittedAt: at.slice(0, 19), note: "checked" })).status).toBe(400); // no zone
    expect((await release(ref, { submittedAt: new Date(START + 2 * DAY).toISOString(), note: "x" })).status).toBe(400); // after receipt
    expect((await release(ref, { submittedAt: new Date(START - 400 * DAY).toISOString(), note: "x" })).status).toBe(400); // beyond IndiaMART
    expect((await release(ref, { submittedAt: at, note: "x", companyName: "X" })).status).toBe(400); // only what the hold allows

    const ok1 = await release(ref, { submittedAt: at, note: "Checked in IndiaMART Lead Manager" });
    expect(ok1.status).toBe(200);
    expect(ok1.body.routing.state.code).toBe("sent_to_sales");
    expect(ok1.body.routing.enquiryTime).toMatchObject({
      asSent: "22/09/2026 10:15 AM", readAs: null, provenance: "reviewer_confirmed",
      confirmed: { byName: "Mo Marketer", note: "Checked in IndiaMART Lead Manager" },
    });
    expect(Date.parse(ok1.body.routing.enquiryTime.confirmed.submittedAt)).toBe(confirmed.getTime());

    /* The enquiry record itself is untouched. */
    const enquiry = await MarketingSourceEnquiry.findOne({ companyId: A }).lean();
    expect([enquiry.submittedAt, enquiry.submittedAtText]).toEqual([null, "22/09/2026 10:15 AM"]);
    const detail = await call("GET", `/api/cms/marketing/enquiries/${ref}`);
    expect(detail.body.enquiry.submittedAt).toBeNull();
    expect(detail.body.enquiry.enquiryContext.submittedAtAsSent).toBe("22/09/2026 10:15 AM");

    const h = await Handover.findOne({ companyId: A }).lean();
    expect(h.sourceEnquiry).toMatchObject({
      submittedAtText: "22/09/2026 10:15 AM", submittedAtProvenance: "reviewer_confirmed",
      submittedAtConfirmedBy: "Mo Marketer", submittedAtConfirmationNote: "Checked in IndiaMART Lead Manager",
    });
    const ev = await MarketingIntentEvent.findOne({ companyId: A, source: "indiamart" }).lean();
    expect(ev.occurredAt.getTime()).toBe(confirmed.getTime());
    expect(ev.evidence).toMatchObject({ providerRecordType: "indiamart_enquiry_time_confirmed", providerTimestamp: "22/09/2026 10:15 AM" });

    const lead = await Lead.findOne({ companyId: A }).lean();
    expect(lead.source).toBe("indiamart");
    expect(lead.marketingHandover.sourceEnquiry).toMatchObject({ submittedAtProvenance: "reviewer_confirmed", submittedAtConfirmedBy: "Mo Marketer" });
    expect(lead.possibleNeed).toContain("confirmed by Mo Marketer");
    expect(lead.possibleNeed).toContain('source time "22/09/2026 10:15 AM"');
    const q = (await salesQueue()).body.handovers[0].queue.sourceEnquiry;
    expect(q).toMatchObject({ madeAtProvenance: "reviewer_confirmed", madeAtConfirmedBy: "Mo Marketer", madeAtAsSent: "22/09/2026 10:15 AM" });
  });

  test("9. an impossible time is its own reason, and is confirmable; a valid old time is a different reason and cannot be confirmed away", async () => {
    answers.push(ok([
      rec({ QUERY_TIME: istText(START + 3 * DAY) }),
      rec({ QUERY_TIME: istText(START - 45 * DAY) }),
    ]));
    await cycle();
    const impossible = await rowFor("submitted_time_implausible");
    const old = await rowFor("too_old");
    expect(impossible).toBeTruthy();
    expect(old).toBeTruthy();
    expect((await release(old.submissionRef, { submittedAt: new Date(START - DAY).toISOString(), note: "x" })).status).toBe(409);
    const r = await release(impossible.submissionRef, { submittedAt: new Date(START - 60 * MINUTE).toISOString(), note: "Seen in Lead Manager" });
    expect(r.body.routing.state.code).toBe("sent_to_sales");
    expect(r.body.routing.enquiryTime.readAs).not.toBeNull(); // IndiaMART's reading is kept beside the confirmation
    expect(r.body.routing.enquiryTime.provenance).toBe("reviewer_confirmed");
  });

  test("10. a confirmed time that turns out old is held as too old, not sent", async () => {
    answers.push(ok([rec({ QUERY_TIME: "not a time" })]));
    await cycle();
    const row = await rowFor("submitted_time_unknown");
    const r = await release(row.submissionRef, { submittedAt: new Date(START - 40 * DAY).toISOString(), note: "Lead Manager shows 40 days ago" });
    expect(r.status).toBe(200);
    expect(r.body.routing.state.code).toBe("held_for_review");
    expect(r.body.routing.reason.code).toBe("too_old");
    expect(r.body.routing.enquiryTime.provenance).toBe("reviewer_confirmed");
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("11. missing company after a confirmed time: the second release keeps the time confirmation", async () => {
    answers.push(ok([rec({ QUERY_TIME: "bad", SENDER_COMPANY: "" })]));
    await cycle();
    const ref = (await rowFor("submitted_time_unknown")).submissionRef;
    const first = await release(ref, { submittedAt: new Date(START - 30 * MINUTE).toISOString(), note: "Checked" });
    expect(first.body.routing.reason.code).toBe("company_name_missing");
    const second = await release(ref, { companyName: "Menon Exports", note: "Asked on the phone" });
    expect(second.body.routing.state.code).toBe("sent_to_sales");
    expect(second.body.routing.enquiryTime.confirmed).toMatchObject({ byName: "Mo Marketer", note: "Checked" });
    const lead = await Lead.findOne({ companyId: A }).lean();
    expect(lead).toMatchObject({ source: "indiamart", company: "Menon Exports" });
    expect(lead.marketingHandover.sourceEnquiry.submittedAtProvenance).toBe("reviewer_confirmed");
  });
});

/* ═══ 4. DOWNTIME AND TENANCY ═════════════════════════════════════════════ */

describe("downtime and tenancy", () => {
  test("12. after long downtime: old enquiries, unreadable ones and recent ones end up in three different places", async () => {
    await MarketingLeadSourceState.create({
      companyId: A, source: "indiamart", coveredFrom: new Date(START - 60 * DAY), coveredThrough: new Date(START - 40 * DAY),
    });
    answers.push(ok([rec({ QUERY_TIME: istText(START - 38 * DAY) }), rec({ QUERY_TIME: "??" })]));
    await cycle();
    for (let i = 0; i < 6; i += 1) {
      later(6 * MINUTE);
      answers.push(ok(i === 5 ? [rec({ QUERY_TIME: istText(clock.now - DAY) })] : []));
      await cycle();
    }
    const rows = await MarketingSourceEnquiryRouting.find({ companyId: A }).lean();
    expect(rows.map((r) => r.reason || r.state).sort()).toEqual(["sent_to_sales", "submitted_time_unknown", "too_old"]);
    const s = (await call("GET", "/api/cms/marketing/lead-sources/indiamart")).body;
    expect(s.indiamart.coverage.freshness.code).toBe("current");
    const held = Object.fromEntries(s.salesRouting.heldOrNotRoutedByReason.map((x) => [x.code, x.count]));
    expect(held).toMatchObject({ too_old: 1, submitted_time_unknown: 1, submitted_time_implausible: 0 });
    expect((await salesQueue()).body.total).toBe(1);
  });

  test("13. another company cannot confirm this company's enquiry time, and its own routing stays its own", async () => {
    answers.push(ok([rec({ QUERY_TIME: "bad" })]));
    await cycle();
    const ref = (await rowFor("submitted_time_unknown")).submissionRef;
    expect((await release(ref, { submittedAt: new Date(START - MINUTE).toISOString(), note: "x" }, { company: B })).status).toBe(404);
    expect((await rowFor("submitted_time_unknown")).timeConfirmation).toBeNull();
    await sync.__internals.saveAll({ companyId: B, records: [rec()], window: { from: new Date(START - DAY), to: new Date(START) }, pulledAt: new Date(START) });
    await routing.routeCompany({ companyId: B, now });
    expect((await salesQueue("", { company: B })).body.handovers[0].queue.source.code).toBe("indiamart");
    expect((await salesQueue()).body.total).toBe(0);
  });
});
