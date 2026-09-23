// test/marketing/indiamart-sales-routing.test.js
//
// INDIAMART BUYER ENQUIRIES REACH SALES ON A SCHEDULE — THROUGH THE EXISTING
// HANDOVER, ONCE EACH — AND NOTHING ELSE DOES.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   The scheduler pulls within IndiaMART's limits, survives downtime, and
//   never calls without a key. Direct enquiries, calls and WhatsApp enquiries
//   become one Marketing handover and at most one draft Sales Lead each,
//   whatever is repeated: pulls, routing passes, deliveries, workers, crashes.
//   Buy-Leads and catalog views never reach Sales. Incomplete or refused items
//   are held with a reason, and a reviewer can release or dismiss them.
//   Permission travels as unknown; no consent is recorded.
//   Another company's enquiries are never routed, listed or released.
//   Simulated: the transport is injected; no test reaches IndiaMART.
"use strict";

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    return next();
  };
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingSourceEnquiry } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const { MarketingSourceEnquiryRouting } = require("../../models/CMS_Models/Marketing/MarketingSourceEnquiryRouting");
const { MarketingLeadSourceState } = require("../../models/CMS_Models/Marketing/MarketingLeadSourceState");
const { MarketingIntentEvent, MarketingOutboxEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { MarketingHandoverReceipt } = require("../../models/CMS_Models/Sales/MarketingProspectIntake");

const { _resetSequence: resetLeadRef } = require("../../services/leadRef");
const producer = require("../../services/marketing/prospectHandover.service");
const salesIntake = require("../../services/sales/marketingProspectIntake.service");
const delivery = require("../../services/integration/marketingProspectDelivery.service");
const scheduler = require("../../services/integration/indiamartScheduler");
const routing = require("../../services/integration/indiamartSalesRouting.service");
const sync = require("../../services/marketing/leads/indiamartSync.service");
const { fail } = require("../../services/storePurchase/errors");
const I = require("../../constants/marketingIndiamart");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const KEY = "rtX9SECRETindiamartKEYvalue42";
/* Close to the real clock: the handover's evidence lookup reads the last 90
   days against the wall clock. */
const START = Math.floor(Date.now() / 1000) * 1000;

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo Marketer", role: "marketing" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin" };

let A; let B;
let server; let base;
const clock = { now: START };
const now = () => clock.now;
const later = (ms) => { clock.now += ms; };
const saved = {};

/* ── A FAKE INDIAMART ──────────────────────────────────────────────────── */
let answers = [];
let calls = 0;
function transport() {
  calls += 1;
  const next = answers.shift();
  if (!next) return Promise.resolve(ok([]));
  if (typeof next === "function") return next();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}
const ok = (records) => ({
  status: 200,
  text: JSON.stringify({ CODE: 200, STATUS: "SUCCESS", MESSAGE: "", TOTAL_RECORDS: records.length, RESPONSE: records }),
});
const code = (c) => ({ status: 200, text: JSON.stringify({ CODE: c, STATUS: "FAILURE", MESSAGE: "x", TOTAL_RECORDS: 0, RESPONSE: [] }) });

/* IndiaMART's time text, in IST. */
const istText = (ms) => new Date(ms + 5.5 * 60 * MINUTE).toISOString().slice(0, 19).replace("T", " ");

let seq = 0;
const rec = (over = {}) => {
  seq += 1;
  return {
    UNIQUE_QUERY_ID: `3${String(100000000 + seq)}`,
    QUERY_TYPE: "W",
    QUERY_TIME: istText(clock.now - 2 * 60 * MINUTE),
    SENDER_NAME: `Buyer ${seq} Sharma`,
    SENDER_MOBILE: `+91-98${String(10000000 + seq).slice(-8)}`,
    SENDER_EMAIL: `buyer${seq}@textiles${seq}.in`,
    SENDER_COMPANY: `Textiles ${seq} Pvt Ltd`,
    SENDER_COUNTRY_ISO: "IN",
    SUBJECT: "Requirement for Polo T-shirts",
    QUERY_PRODUCT_NAME: "Polo T-shirts",
    QUERY_MCAT_NAME: "Corporate T-Shirts",
    QUERY_MESSAGE: `Need ${seq}00 pcs with logo embroidery.`,
    ...over,
  };
};

const cycle = (over = {}) => scheduler.runCycle({ now, transport, isEnabled: async () => true, ...over });
const rowsOf = (company = A) => MarketingSourceEnquiryRouting.find({ companyId: company }).sort({ createdAt: 1 }).lean();
const stateCounts = async (company = A) => {
  const out = {};
  for (const r of await rowsOf(company)) out[r.state] = (out[r.state] || 0) + 1;
  return out;
};

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
const refOfHeld = async (reason) => (await MarketingSourceEnquiryRouting.findOne({ companyId: A, reason }).lean()).submissionRef;

beforeAll(async () => {
  for (const k of ["MARKETING_COMPANY_ID", I.KEY_ENV]) saved[k] = process.env[k];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.locals.marketingIndiamartTransport = transport;
  app.locals.marketingIndiamartClock = now;
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/enquiries"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/leadSources"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
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
  calls = 0;
});

/* ═══ 1. THE SCHEDULE ═════════════════════════════════════════════════════ */

describe("the schedule", () => {
  test("1. without a key, or switched off, a cycle reads nothing, writes nothing and calls nobody", async () => {
    delete process.env[I.KEY_ENV];
    expect(await cycle()).toEqual({ skipped: "not_configured" });
    process.env[I.KEY_ENV] = KEY;
    expect(await cycle({ isEnabled: async () => false })).toEqual({ skipped: "disabled" });
    process.env.MARKETING_COMPANY_ID = "not-an-id";
    expect(await cycle()).toEqual({ skipped: "not_configured" });
    expect(calls).toBe(0);
    expect(await MarketingLeadSourceState.countDocuments({})).toBe(0);
  });

  test("2. a scheduled cycle pulls and routes: buyer enquiries reach Sales, prospects do not, unknown types wait", async () => {
    answers.push(ok([
      rec({ QUERY_TYPE: "W" }), rec({ QUERY_TYPE: "P", CALL_DURATION: "84" }), rec({ QUERY_TYPE: "WA" }),
      rec({ QUERY_TYPE: "B" }), rec({ QUERY_TYPE: "BIZ" }), rec({ QUERY_TYPE: "Q" }),
    ]));
    const out = await cycle();
    expect(out.pull.outcome).toBe("completed");
    expect(out.routed).toMatchObject({ discovered: 6, sentToSales: 3, notRouted: 2, held: 1, delivered: 0 });
    expect(await stateCounts()).toEqual({ sent_to_sales: 3, not_routed: 2, held_for_review: 1 });
    expect(await Handover.countDocuments({ companyId: A })).toBe(3);
    expect(await Lead.countDocuments({ companyId: A })).toBe(3);
    expect(await Enquiry.countDocuments({})).toBe(0);
    const reasons = (await rowsOf()).filter((r) => r.reason).map((r) => r.reason).sort();
    expect(reasons).toEqual(["kind_not_routed", "kind_not_routed", "unclassified_type"]);

    const st = await MarketingLeadSourceState.findOne({ companyId: A }).lean();
    expect(st.lastRun.startedBy).toBe("scheduler");
    expect(st.lastScheduledCycleOutcome).toBe("completed");
  });

  test("3. cycles inside IndiaMART's 5 minutes do not call, but still route and deliver", async () => {
    answers.push(ok([rec()]));
    await cycle();
    later(1 * MINUTE);
    const soon = await cycle();
    expect(soon.pull.refused).toBe("LEAD_SOURCE_CHECK_TOO_SOON");
    expect(soon.routed).toBeTruthy();
    expect(calls).toBe(1);
    expect((await MarketingLeadSourceState.findOne({ companyId: A }).lean()).lastScheduledCycleOutcome).toBe("waiting_rate_limit");
    later(5 * MINUTE);
    await cycle();
    expect(calls).toBe(2);
  });

  test("4. after a 429 nothing calls IndiaMART for 15 minutes", async () => {
    answers.push(code(429));
    await cycle();
    for (const step of [6, 6]) {
      later(step * MINUTE);
      await cycle();
    }
    expect(calls).toBe(1);
    later(4 * MINUTE);
    await cycle();
    expect(calls).toBe(2);
  });

  test("5. two workers (two processes) at once: one IndiaMART call, one handover per enquiry", async () => {
    let release;
    answers.push(() => new Promise((r) => { release = () => r(ok([rec(), rec()])); }));
    const w1 = scheduler.cycleFor({ companyId: A, now, transport });
    await new Promise((r) => setTimeout(r, 100));
    const w2 = scheduler.cycleFor({ companyId: A, now, transport });
    await new Promise((r) => setTimeout(r, 100));
    release();
    const [a, b] = await Promise.all([w1, w2]);
    expect([a.pull.outcome, b.pull.refused].sort()).toEqual(["LEAD_SOURCE_CHECK_IN_PROGRESS", "completed"].sort());
    await Promise.all([routing.routeCompany({ companyId: A, now }), routing.routeCompany({ companyId: A, now })]);
    expect(calls).toBe(1);
    expect(await Handover.countDocuments({ companyId: A })).toBe(2);
    expect(await Lead.countDocuments({ companyId: A })).toBe(2);
  });

  test("6. downtime: the cursor catches up 7 days a cycle; requests older than 30 days are held, recent ones reach Sales; freshness says so", async () => {
    await MarketingLeadSourceState.create({
      companyId: A, source: "indiamart",
      coveredFrom: new Date(START - 60 * DAY), coveredThrough: new Date(START - 40 * DAY),
      lastSuccessAt: new Date(START - 40 * DAY),
      lastRun: {
        startedAt: new Date(START - 40 * DAY), finishedAt: new Date(START - 40 * DAY), outcome: "completed",
        windowFrom: new Date(START - 47 * DAY), windowTo: new Date(START - 40 * DAY),
      },
    });
    const stalled = (await call("GET", "/lead-sources/indiamart")).body.indiamart.coverage;
    expect(stalled.freshness.code).toBe("stalled");
    expect(stalled.lagMinutes).toBe(40 * 24 * 60);

    answers.push(ok([rec({ QUERY_TIME: istText(START - 36 * DAY) })]));
    await cycle();
    const catching = (await call("GET", "/lead-sources/indiamart")).body.indiamart.coverage;
    expect(catching.freshness.code).toBe("catching_up");
    expect(catching.catchingUp).toBe(true);
    expect(await stateCounts()).toEqual({ held_for_review: 1 });
    expect((await rowsOf())[0].reason).toBe("too_old");

    for (let i = 0; i < 5; i += 1) {
      later(6 * MINUTE);
      answers.push(ok(i === 4 ? [rec({ QUERY_TIME: istText(clock.now - 3 * DAY) })] : []));
      await cycle();
    }
    const after = (await call("GET", "/lead-sources/indiamart")).body.indiamart.coverage;
    expect(after.freshness.code).toBe("current");
    expect(Date.parse(after.coveredThrough)).toBe(clock.now);
    expect(await stateCounts()).toEqual({ held_for_review: 1, sent_to_sales: 1 });
    expect(calls).toBe(6);
  });
});

/* ═══ 2. ONCE, WHATEVER REPEATS ═══════════════════════════════════════════ */

describe("idempotency", () => {
  test("7. overlapping windows and repeated pulls route each enquiry once", async () => {
    const r1 = rec(); const r2 = rec();
    answers.push(ok([r1, r2]));
    await cycle();
    later(6 * MINUTE);
    answers.push(ok([r1, r2, rec()]));
    const second = await cycle();
    expect(second.pull.check.counts).toMatchObject({ recorded: 1, alreadyHeld: 2 });
    expect(second.routed.sentToSales).toBe(1);
    expect(await Handover.countDocuments({ companyId: A })).toBe(3);
    expect(await Lead.countDocuments({ companyId: A })).toBe(3);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A, source: "indiamart" })).toBe(3);
  });

  test("8. repeated routing passes and repeated deliveries create nothing new", async () => {
    answers.push(ok([rec(), rec()]));
    await cycle();
    for (let i = 0; i < 3; i += 1) await routing.routeCompany({ companyId: A, now });
    const again = await delivery.deliverPending({ companyId: A });
    expect(again.attempted).toBe(0);
    /* Replaying Sales' receipt directly: the ledger answers duplicate. */
    const outbox = await MarketingOutboxEvent.find({ companyId: A }).lean();
    for (const e of outbox) {
      const r = await salesIntake.receive(e, { readHandover: producer.readByRef });
      expect(r.duplicate).toBe(true);
    }
    expect(await Handover.countDocuments({ companyId: A })).toBe(2);
    expect(await Lead.countDocuments({ companyId: A })).toBe(2);
    expect(await MarketingHandoverReceipt.countDocuments({ companyId: A })).toBe(2);
  });

  test("9. a crash after the handover is written: the retry finds the same handover; one Lead", async () => {
    answers.push(ok([rec()]));
    await sync.check({ companyId: A, now, transport });
    const realUpdate = MarketingSourceEnquiryRouting.updateOne.bind(MarketingSourceEnquiryRouting);
    let failed = false;
    jest.spyOn(MarketingSourceEnquiryRouting, "updateOne").mockImplementation((filter, update, ...rest) => {
      if (!failed && update?.$set?.state === "sent_to_sales") {
        failed = true;
        return Promise.reject(Object.assign(new Error("connection lost"), { name: "MongoNetworkError" }));
      }
      return realUpdate(filter, update, ...rest);
    });
    await routing.routeCompany({ companyId: A, now });
    let [row] = await rowsOf();
    expect(row.state).toBe("retrying");
    const firstRef = (await Handover.findOne({ companyId: A }).lean()).handoverRef;

    later(2 * MINUTE);
    await routing.routeCompany({ companyId: A, now });
    [row] = await rowsOf();
    expect(row.state).toBe("sent_to_sales");
    expect(row.handoverRef).toBe(firstRef);
    expect(await Handover.countDocuments({ companyId: A })).toBe(1);
    expect(await Lead.countDocuments({ companyId: A })).toBe(1);
  });

  test("10. a partial save: what was saved is routed; the refetch routes only the rest", async () => {
    const recs = [rec(), rec(), rec()];
    const real = MarketingSourceEnquiry.create.bind(MarketingSourceEnquiry);
    let n = 0;
    const spy = jest.spyOn(MarketingSourceEnquiry, "create").mockImplementation((doc) => {
      n += 1;
      if (n === 2) return Promise.reject(Object.assign(new Error("reset"), { name: "MongoNetworkError" }));
      return real(doc);
    });
    answers.push(ok(recs));
    const first = await cycle();
    expect(first.pull.check.error.code).toBe("storage_failed");
    expect(first.routed.sentToSales).toBe(1);
    expect((await MarketingLeadSourceState.findOne({ companyId: A }).lean()).coveredThrough).toBeNull();
    spy.mockRestore();
    later(6 * MINUTE);
    answers.push(ok(recs));
    const second = await cycle();
    expect(second.pull.check.counts).toMatchObject({ recorded: 2, alreadyHeld: 1 });
    expect(second.routed.sentToSales).toBe(2);
    expect(await Lead.countDocuments({ companyId: A })).toBe(3);
  });

  test("11. the same buyer enquiring twice: two handovers, one Sales Lead — Sales links the second", async () => {
    const buyer = { SENDER_MOBILE: "+91-9876500001", SENDER_EMAIL: "same@buyer.in", SENDER_NAME: "Same Buyer", SENDER_COMPANY: "Same Co" };
    answers.push(ok([rec(buyer), rec({ ...buyer, QUERY_TYPE: "P" })]));
    await cycle();
    expect(await Handover.countDocuments({ companyId: A })).toBe(2);
    expect(await Lead.countDocuments({ companyId: A })).toBe(1);
    const outcomes = (await MarketingHandoverReceipt.find({ companyId: A }).lean()).map((r) => r.intakeOutcome).sort();
    expect(outcomes).toEqual(["CREATED", "LINKED"]);
  });
});

/* ═══ 3. WHAT SALES RECEIVES ══════════════════════════════════════════════ */

describe("what Sales receives", () => {
  test("12. the Lead keeps the source, the request in the buyer's words and the times; unassigned; permission unknown", async () => {
    const submitted = clock.now - 2 * 60 * MINUTE;
    answers.push(ok([rec({ QUERY_TYPE: "P", CALL_DURATION: "84", QUERY_TIME: istText(submitted) })]));
    await cycle();
    const lead = await Lead.findOne({ companyId: A }).lean();
    const row = (await rowsOf())[0];
    /* Its own Lead source since 2026-09-22 — never counted as a campaign. */
    expect(lead).toMatchObject({
      source: "indiamart",
      sourceDetails: "Phone call",
      captureStatus: "draft",
      interestSignal: "requested_product_info",
    });
    expect(lead.campaignOrEvent).toBeUndefined();
    expect(lead.assignedTo).toBeUndefined();
    expect(lead.possibleNeed).toContain("Phone call via IndiaMART — Phone call");
    expect(lead.marketingHandover.sourceEnquiry).toMatchObject({
      source: "indiamart", sourceRef: row.submissionRef, kind: "buyer_enquiry", channel: "Phone call", submittedAtProvenance: "source",
    });
    expect(lead.possibleNeed).toContain(`ref ${row.submissionRef}`);
    expect(lead.possibleNeed).toContain("Product: Polo T-shirts.");
    expect(lead.possibleNeed).toContain("Message: Need");
    expect(lead.possibleNeed).toContain("Call length: 84 seconds.");
    expect(lead.marketingHandover).toMatchObject({ sourceSystem: "indiamart", emailConsent: "unknown", phoneConsent: "unknown" });

    const h = await Handover.findOne({ companyId: A }).lean();
    expect(h.sourceEnquiry).toMatchObject({ source: "indiamart", sourceRef: row.submissionRef, channel: "Phone call", callDurationSeconds: 84 });
    expect(new Date(h.sourceEnquiry.submittedAt).getTime()).toBe(Math.floor(submitted / 1000) * 1000);
    expect(new Date(h.activities[0].occurredAt).getTime()).toBe(Math.floor(submitted / 1000) * 1000);
    expect(h.permission).toMatchObject({ emailConsent: "unknown", phoneConsent: "unknown", suppressed: false });
    const receipt = await MarketingHandoverReceipt.findOne({ companyId: A }).lean();
    expect(receipt.package.sourceEnquiry.sourceRef).toBe(row.submissionRef);
  });

  test("13. no marketing consent is recorded, and no IndiaMART id reaches the handover or Sales", async () => {
    const r = rec({ UNIQUE_QUERY_ID: "3999999999" });
    answers.push(ok([r]));
    await cycle();
    expect(await MarketingConsent.countDocuments({})).toBe(0);
    const text = JSON.stringify(await Handover.find({}).lean()) + JSON.stringify(await Lead.find({}).lean())
      + JSON.stringify(await MarketingHandoverReceipt.find({}).lean()) + JSON.stringify(await MarketingIntentEvent.find({}).lean());
    expect(text).not.toContain("3999999999");
    expect(text).not.toContain(KEY);
  });
});

/* ═══ 4. HELD, BLOCKED AND RETRIED ════════════════════════════════════════ */

describe("holds and retries", () => {
  test("14. incomplete, unreadable and old items are held with a reason, and never reach Sales", async () => {
    answers.push(ok([
      rec({ SENDER_NAME: "IndiaMART Buyer" }),
      rec({ SENDER_COMPANY: "" }),
      rec({ SENDER_MOBILE: "", SENDER_EMAIL: "" }),
      rec({ SENDER_EMAIL: "not-an-address", SENDER_MOBILE: "+91-9000011111" }),
      rec({ QUERY_TIME: "07-Dec-2021 09:00" }),
      rec({ QUERY_TIME: istText(clock.now - 31 * DAY) }),
    ]));
    await cycle();
    const reasons = (await rowsOf()).map((r) => r.reason).sort();
    expect(reasons).toEqual([
      "company_name_missing", "contact_invalid", "contact_missing", "name_missing", "submitted_time_unknown", "too_old",
    ]);
    expect(await Handover.countDocuments({})).toBe(0);
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("15. a reviewer releases a held enquiry with only what its reason allows; it reaches Sales once", async () => {
    answers.push(ok([rec({ SENDER_COMPANY: "" }), rec({ SENDER_NAME: "IndiaMART Buyer" }), rec({ SENDER_EMAIL: "bad", SENDER_MOBILE: "+91-9000022222" })]));
    await cycle();
    const companyRef = await refOfHeld("company_name_missing");
    const release = (ref, body) => call("POST", `/lead-sources/indiamart/enquiries/${ref}/release`, { body });

    expect((await release(companyRef, {})).status).toBe(400);
    expect((await release(companyRef, { companyName: "Acme", contactName: "X" })).status).toBe(400);
    const ok1 = await release(companyRef, { companyName: "Sharma Traders", note: "Called; trading as Sharma Traders" });
    expect(ok1.status).toBe(200);
    expect(ok1.body.routing).toMatchObject({ state: { code: "sent_to_sales" }, delivery: { code: "delivered" }, salesOutcome: { code: "awaiting_sales_review" } });
    expect(ok1.body.routing.review).toMatchObject({ action: "release", byName: "Mo Marketer" });
    const h = await Handover.findOne({ companyId: A, handoverRef: ok1.body.routing.handoverRef }).lean();
    expect(h.company.name).toBe("Sharma Traders");
    expect(h.submittedBy.name).toBe("Mo Marketer");

    /* Released twice: refused, nothing new. */
    expect((await release(companyRef, { companyName: "Other" })).status).toBe(409);

    const nameRef = await refOfHeld("name_missing");
    expect((await release(nameRef, { contactName: "Priya Nair" })).body.routing.state.code).toBe("sent_to_sales");
    const emailRef = await refOfHeld("contact_invalid");
    expect((await release(emailRef, { usePhoneOnly: true })).body.routing.state.code).toBe("sent_to_sales");
    expect(await Lead.countDocuments({ companyId: A })).toBe(3);
    const phoneOnly = await Lead.findOne({ companyId: A, phone: "+91-9000022222" }).lean();
    expect(phoneOnly.email || "").toBe("");
  });

  test("16. what cannot be released must be dismissed, with a reason", async () => {
    answers.push(ok([rec({ QUERY_TIME: istText(clock.now - 40 * DAY) }), rec({ QUERY_TYPE: "B" })]));
    await cycle();
    const oldRef = await refOfHeld("too_old");
    expect((await call("POST", `/lead-sources/indiamart/enquiries/${oldRef}/release`, { body: {} })).status).toBe(409);
    expect((await call("POST", `/lead-sources/indiamart/enquiries/${oldRef}/dismiss`, { body: {} })).status).toBe(400);
    const d = await call("POST", `/lead-sources/indiamart/enquiries/${oldRef}/dismiss`, { body: { note: "Buyer already ordered offline" } });
    expect(d.body.routing.state.code).toBe("dismissed");
    /* A Buy-Lead is not held: it is not routed, and cannot be released. */
    const buyLead = (await rowsOf()).find((r) => r.state === "not_routed");
    expect((await call("POST", `/lead-sources/indiamart/enquiries/${buyLead.submissionRef}/release`, { body: {} })).status).toBe(409);
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("17. a blocked handover is held with its reason; a refused field is held naming it", async () => {
    answers.push(ok([rec(), rec()]));
    await sync.check({ companyId: A, now, transport });
    const spy = jest.spyOn(producer, "submit");
    spy.mockImplementationOnce(async () => ({
      blocked: true, reason: "This person is suppressed from marketing contact.", duplicate: false,
      handover: { _id: new mongoose.Types.ObjectId(), handoverRef: "MHO-2026-9001", correlationId: "c1" },
    }));
    spy.mockImplementationOnce(async () => { throw fail("VALIDATION", "That work email address is not a valid address.", { field: "person.workEmail" }); });
    await routing.routeCompany({ companyId: A, now });
    const rows = await rowsOf();
    expect(rows.map((r) => r.reason).sort()).toEqual(["handover_blocked", "handover_refused"]);
    expect(rows.find((r) => r.reason === "handover_blocked").reasonDetail).toMatch(/suppressed/);
    expect(rows.find((r) => r.reason === "handover_refused").reasonDetail).toMatch(/person\.workEmail/);
    expect(await Lead.countDocuments({})).toBe(0);
  });

  test("18. temporary failures back off and retry; after the limit the item is held and can be retried by a person", async () => {
    answers.push(ok([rec()]));
    await sync.check({ companyId: A, now, transport });
    const spy = jest.spyOn(producer, "submit").mockRejectedValue(Object.assign(new Error("db down"), { name: "MongoServerSelectionError" }));
    await routing.routeCompany({ companyId: A, now });
    let [row] = await rowsOf();
    expect(row).toMatchObject({ state: "retrying", attempts: 1 });
    expect(new Date(row.nextAttemptAt).getTime()).toBe(clock.now + MINUTE);
    /* Not due yet: not retried. */
    await routing.routeCompany({ companyId: A, now });
    expect(spy).toHaveBeenCalledTimes(1);
    for (let i = 2; i <= I.ROUTING.MAX_ATTEMPTS; i += 1) {
      later(I.ROUTING.RETRY_MAX_MS);
      await routing.routeCompany({ companyId: A, now });
    }
    [row] = await rowsOf();
    expect(row).toMatchObject({ state: "held_for_review", reason: "routing_failed", attempts: I.ROUTING.MAX_ATTEMPTS });
    spy.mockRestore();
    const r = await call("POST", `/lead-sources/indiamart/enquiries/${row.submissionRef}/release`, { body: { retry: true } });
    expect(r.body.routing.state.code).toBe("sent_to_sales");
    expect(await Lead.countDocuments({})).toBe(1);
  });

  test("19. Sales temporarily refusing the delivery: the handover waits and is delivered next cycle, once", async () => {
    const realReceive = salesIntake.receive;
    /* Refused twice: the routing attempt and the same cycle's delivery sweep. */
    const spy = jest.spyOn(salesIntake, "receive")
      .mockRejectedValueOnce(new Error("sales unavailable"))
      .mockRejectedValueOnce(new Error("sales unavailable"));
    answers.push(ok([rec()]));
    await cycle();
    let [row] = await rowsOf();
    expect(row.state).toBe("sent_to_sales");
    expect(row.deliveredAt).toBeNull();
    const s1 = (await call("GET", "/lead-sources/indiamart/routing")).body.routing[0];
    expect(s1.delivery.code).toBe("pending");
    expect(await Lead.countDocuments({})).toBe(0);
    spy.mockImplementation(realReceive);
    later(6 * MINUTE);
    const next = await cycle();
    expect(next.routed.delivered).toBe(1);
    [row] = await rowsOf();
    expect(row.deliveredAt).not.toBeNull();
    expect(await Lead.countDocuments({})).toBe(1);
  });
});

/* ═══ 5. WHAT MARKETING SEES, AND WHO ════════════════════════════════════ */

describe("visibility, privacy and tenancy", () => {
  test("20. status and routing show source quality and handover outcomes, without contact details or ids", async () => {
    const r1 = rec({ UNIQUE_QUERY_ID: "3888888888" });
    answers.push(ok([r1, rec({ QUERY_TYPE: "B" }), rec({ SENDER_COMPANY: "" })]));
    await cycle();
    const s = await call("GET", "/lead-sources/indiamart");
    const list = await call("GET", "/lead-sources/indiamart/routing");
    const byState = Object.fromEntries(s.body.salesRouting.byState.map((x) => [x.code, x.count]));
    expect(byState).toMatchObject({ sent_to_sales: 1, not_routed: 1, held_for_review: 1 });
    expect(s.body.salesRouting.delivery).toEqual({ delivered: 1, pending: 0 });
    expect(s.body.salesRouting.salesOutcomes.find((o) => o.code === "awaiting_sales_review").count).toBe(1);
    expect(s.body.salesRouting.marketingPermission.recorded).toBe(false);
    expect(s.body.indiamart.automaticChecks).toMatchObject({ enabled: true, everyMinutes: 6 });
    expect(list.body.routing).toHaveLength(3);
    for (const res of [s, list]) {
      for (const secret of [KEY, "3888888888", r1.SENDER_MOBILE, r1.SENDER_EMAIL, "correlationId", "claimToken"]) {
        expect([secret, res.text.includes(secret)]).toEqual([secret, false]);
      }
    }
    const held = await call("GET", "/lead-sources/indiamart/routing?state=held_for_review");
    expect(held.body.routing[0].reason).toMatchObject({ code: "company_name_missing", release: "companyName" });
    expect((await call("GET", "/lead-sources/indiamart/routing?state=nope")).status).toBe(400);

    const ref = list.body.routing.find((x) => x.state.code === "sent_to_sales").submissionRef;
    const detail = await call("GET", `/enquiries/${ref}`);
    expect(detail.body.enquiry.salesRouting).toMatchObject({ state: { code: "sent_to_sales" }, delivery: { code: "delivered" } });
    /* The inbox still says permission was never asked for. */
    expect(detail.body.enquiry).toMatchObject({ consent: "no_permission_recorded", consentBasis: "source_does_not_ask" });
  });

  test("21. another company's enquiries are never routed, listed or released by this company", async () => {
    const { saveAll } = sync.__internals;
    await saveAll({ companyId: B, records: [rec()], window: { from: new Date(START - DAY), to: new Date(START) }, pulledAt: new Date(START) });
    await cycle();
    expect(await MarketingSourceEnquiryRouting.countDocuments({ companyId: B })).toBe(0);
    await routing.routeCompany({ companyId: A, now });
    expect(await MarketingSourceEnquiryRouting.countDocuments({ companyId: B })).toBe(0);

    /* B's own routing runs only for B, and A cannot see or act on it. */
    await routing.routeCompany({ companyId: B, now });
    const bRow = await MarketingSourceEnquiryRouting.findOne({ companyId: B }).lean();
    expect(bRow.state).toBe("sent_to_sales");
    expect((await call("GET", "/lead-sources/indiamart/routing")).body.routing).toHaveLength(0);
    expect((await call("POST", `/lead-sources/indiamart/enquiries/${bRow.submissionRef}/dismiss`, { body: { note: "x" } })).status).toBe(404);
    expect(await Lead.countDocuments({ companyId: A })).toBe(0);
  });

  test("22. Check now runs the same cycle for an administrator; a marketer cannot; the Marketing guard agrees", async () => {
    answers.push(ok([rec()]));
    expect((await call("POST", "/lead-sources/indiamart/check")).status).toBe(403);
    const c = await call("POST", "/lead-sources/indiamart/check", { user: ADMIN });
    expect(c.status).toBe(200);
    expect(c.body.routed.sentToSales).toBe(1);
    expect((await MarketingLeadSourceState.findOne({ companyId: A }).lean()).lastRun.startedBy).toBe("manual");
    const access = require("../../services/marketing/marketingAccess");
    expect(access.actFor("POST", "/lead-sources/indiamart/check")).toBe("administer");
    expect(access.actFor("POST", "/lead-sources/indiamart/enquiries/MSE-0123456789abcdef/release")).toBe("write");
    expect(access.actFor("GET", "/lead-sources/indiamart/routing")).toBe("read");
  });

  test("23. the boundary: the routing writer requires no Sales module, and Marketing's read side requires no integration", () => {
    const src = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");
    for (const f of ["services/integration/indiamartSalesRouting.service.js", "services/integration/indiamartScheduler.js"]) {
      expect(src(f)).not.toMatch(/require\([^)]*(\/sales\/|Sales\/|leadReview|leadQualification)/);
    }
    for (const f of ["services/marketing/leads/indiamartRouting.read.js", "services/marketing/leads/indiamartSync.service.js"]) {
      expect(src(f)).not.toMatch(/require\([^)]*(integration|\/sales\/|Sales\/)/);
    }
  });
});
