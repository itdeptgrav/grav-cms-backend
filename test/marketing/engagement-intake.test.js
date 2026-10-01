// test/marketing/engagement-intake.test.js
//
// TRUSTWORTHY ENGAGEMENT INTAKE: the ledger, the suppression, and the few
// milestones that reach the Sales timeline.
//
// The production translator, intake, processing and projection all run; only
// the transport into Mautic is a double, and most of this suite never needs
// one. The negative cases dominate on purpose — a pipeline that records events
// is easy, and the value is entirely in what it refuses to do with them.
"use strict";

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const contract = require("../../services/marketing/mauticWebhookContract");
const eventIntake = require("../../services/marketing/mauticEventIntake.service");
const engagement = require("../../services/marketing/engagementProcessing.service");
const projection = require("../../services/marketing/crmActivityProjection.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const {
  MarketingIntentEvent, EVENT_IMMUTABLE_MESSAGE,
} = require("../../models/CMS_Models/Marketing/MarketingEvent");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { createWithRef } = require("../../services/leadRef");

const KEY = "grav-person-engage-1";
const EMAIL = "meera@aurorahotels.in";
const CONTACT_ID = "44";

let COMPANY;
let OTHER_COMPANY;
let server;
let base;
const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "N", role: "marketing", email: "n@grav.in" };

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/dataHealth"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  const co = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  COMPANY = co._id;
  OTHER_COMPANY = new mongoose.Types.ObjectId();
});

const api = async (path) => {
  const r = await fetch(`${base}${path}`, { headers: { "x-test-user": JSON.stringify(MARKETER) } });
  return { status: r.status, body: await r.json() };
};

/** A marketing identity with the Mautic mapping GRAV made. */
const identity = (over = {}) => MarketingIdentity.create({
  companyId: COMPANY, gravPersonKey: KEY, email: EMAIL,
  externals: [{ system: "mautic", externalId: CONTACT_ID, proven: true }],
  ...over,
});

const grantConsent = (key = KEY) => consentService.record({
  companyId: COMPANY, gravPersonKey: key, ...consentService.MARKETING_EMAIL,
  state: "opted_in", capturedSource: "test form", actor: { name: "T" },
});

/* ── PAYLOAD BUILDERS, shaped like real Mautic 7.2.0 deliveries ─────────── */
const leadBlock = (id = CONTACT_ID, email = EMAIL) => ({
  id: Number(id), fields: { core: { email: { value: email } } },
});

const P = {
  send: (statId = 1, at = "2026-09-09T08:00:00+00:00") => ({
    "mautic.email_on_send": [{ stat: { id: statId, emailAddress: EMAIL, dateSent: at, email: { id: 12, name: "Sept refresh" }, lead: leadBlock() }, timestamp: at }],
  }),
  open: (statId = 2, at = "2026-09-09T09:00:00+00:00") => ({
    "mautic.email_on_open": [{ stat: { id: statId, emailAddress: EMAIL, dateRead: at, email: { id: 12, name: "Sept refresh" }, lead: leadBlock() }, timestamp: at }],
  }),
  click: (hitId = 3, at = "2026-09-09T10:00:00+00:00") => ({
    "mautic.page_on_hit": [{ hit: { id: hitId, dateHit: at, url: "https://grav.in/uniforms", email: { id: 12, name: "Sept refresh" }, lead: leadBlock() }, timestamp: at }],
  }),
  view: (hitId = 4, at = "2026-09-09T10:05:00+00:00") => ({
    "mautic.page_on_hit": [{ hit: { id: hitId, dateHit: at, url: "https://grav.in/about", lead: leadBlock() }, timestamp: at }],
  }),
  form: (subId = 5, at = "2026-09-09T11:00:00+00:00") => ({
    "mautic.form_on_submit": [{ submission: { id: subId, dateSubmitted: at, form: { id: 3, name: "Uniform guide" }, results: { email: EMAIL, product_interest: "housekeeping uniforms" }, lead: leadBlock() }, timestamp: at }],
  }),
  delivered: (statId = 6, at = "2026-09-09T08:01:00+00:00") => ({
    "mautic.email_on_delivered": [{ stat: { id: statId, emailAddress: EMAIL, dateDelivered: at, email: { id: 12 }, lead: leadBlock() }, timestamp: at }],
  }),
  unsub: (dncId = 7, at = "2026-09-09T12:00:00+00:00") => ({
    "mautic.lead_channel_subscription_changed": [{
      contact: { ...leadBlock(), doNotContact: [{ id: dncId, channel: "email", comments: "", dateAdded: at }] },
      channel: "email", old_status: "contactable", new_status: "unsubscribed", timestamp: at,
    }],
  }),
  bounce: (dncId = 8, comments = "550 5.1.1 <x> User unknown", at = "2026-09-09T13:00:00+00:00") => ({
    "mautic.lead_channel_subscription_changed": [{
      contact: { ...leadBlock(), doNotContact: [{ id: dncId, channel: "email", comments, dateAdded: at }] },
      channel: "email", old_status: "contactable", new_status: "bounced", timestamp: at,
    }],
  }),
};

/** Translate a payload and run the whole production pipeline over it. */
async function ingest(payload, companyId = null) {
  const co = companyId || COMPANY;
  const { events, rejected, ignored } = contract.translate(payload);
  const out = [];
  for (const e of events) {
    const r = await eventIntake.recordEvent({ companyId: co, event: e });
    const row = await MarketingIntentEvent.findById(r.eventId).lean();
    const receipt = row ? await engagement.processEvent({ companyId: co, event: row }) : null;
    out.push({ ...r, event: row, receipt });
  }
  return { results: out, rejected, ignored, events };
}

/* ═══ 1. ALL SIX EMAIL EVENT TYPES TRANSLATE ═══════════════════════════════ */

describe("The six email facts", () => {
  test("each translates to its own kind with its own deterministic id", () => {
    const cases = [
      [P.send(), "email_sent", "mautic.email_on_send:stat:1"],
      [P.delivered(), "email_delivered", "mautic.email_on_delivered:stat:6"],
      [P.open(), "email_opened", "mautic.email_on_open:stat:2"],
      [P.click(), "email_clicked", "mautic.page_on_hit:hit:3"],
      [P.bounce(), "email_bounced", "mautic.lead_channel_subscription_changed:dnc:8"],
      [P.unsub(), "email_unsubscribed", "mautic.lead_channel_subscription_changed:dnc:7"],
    ];
    for (const [payload, kind, id] of cases) {
      const { events, rejected } = contract.translate(payload);
      expect(rejected).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe(kind);
      expect(events[0].sourceEventId).toBe(id);
      expect(events[0].email).toBe(EMAIL);
      expect(events[0].externalContactId).toBe(CONTACT_ID);
    }
  });

  test("a hit without an email reference is a page view, not a click", () => {
    expect(contract.translate(P.view()).events[0].kind).toBe("page_viewed");
  });

  test("bounce classification keeps hard, soft and unclassifiable apart", () => {
    expect(contract.classifyBounce("550 5.1.1 user unknown")).toBe("hard");
    expect(contract.classifyBounce("452 4.2.2 mailbox full")).toBe("soft");
    expect(contract.classifyBounce("the server said something odd")).toBe("unknown");
    expect(contract.classifyBounce("")).toBe("unknown");
  });

  test("a manual do-not-contact is a withdrawal; a re-subscribe is only recorded", () => {
    const manual = contract.translate({
      "mautic.lead_channel_subscription_changed": [{
        contact: { ...leadBlock(), doNotContact: [{ id: 20, channel: "email" }] },
        channel: "email", old_status: "contactable", new_status: "manual", timestamp: "2026-09-09T12:00:00+00:00",
      }],
    });
    expect(manual.events[0].kind).toBe("email_unsubscribed");

    const back = contract.translate({
      "mautic.lead_channel_subscription_changed": [{
        contact: leadBlock(), channel: "email", old_status: "unsubscribed",
        new_status: "contactable", timestamp: "2026-09-09T14:00:00+00:00",
      }],
    });
    expect(back.events[0].kind).toBe("email_resubscribed");
  });

  test("a non-email channel is refused rather than suppressing an email address", () => {
    const { rejected, events } = contract.translate({
      "mautic.lead_channel_subscription_changed": [{
        contact: leadBlock(), channel: "sms", old_status: "contactable",
        new_status: "unsubscribed", timestamp: "2026-09-09T12:00:00+00:00",
      }],
    });
    expect(events).toHaveLength(0);
    expect(rejected[0].reason).toContain("does not model");
  });

  test("there is no read-duration or dwell-time field anywhere", () => {
    const fields = Object.keys(MarketingIntentEvent.schema.paths).join(" ").toLowerCase();
    for (const banned of ["duration", "dwell", "readtime", "exittime", "secondsread", "timeonpage"]) {
      expect(fields).not.toContain(banned);
    }
  });
});

/* ═══ 2. SIGNATURE OVER EXACT BYTES ════════════════════════════════════════ */

describe("Webhook authenticity", () => {
  const SECRET = "chunk-2-secret";
  const body = JSON.stringify(P.open());
  const b64 = (b, secret = SECRET) => crypto.createHmac("sha256", secret).update(Buffer.from(b, "utf8")).digest("base64");
  const hex = (b, secret = SECRET) => crypto.createHmac("sha256", secret).update(Buffer.from(b, "utf8")).digest("hex");

  test("genuine Mautic base64 in Webhook-Signature is accepted", () => {
    expect(contract.verifySignature(Buffer.from(body), b64(body), SECRET)).toMatchObject({ ok: true, encoding: "base64" });
    expect(contract.signatureFrom({ "webhook-signature": "x" }).header).toBe("webhook-signature");
  });

  test("the GRAV synthetic hex signature is still accepted", () => {
    expect(contract.verifySignature(Buffer.from(body), hex(body), SECRET)).toMatchObject({ ok: true, encoding: "hex" });
  });

  test("wrong, missing, and modified-body signatures are all refused", () => {
    expect(contract.verifySignature(Buffer.from(body), b64(body, "wrong"), SECRET).ok).toBe(false);
    expect(contract.verifySignature(Buffer.from(body), "", SECRET).ok).toBe(false);
    expect(contract.verifySignature(Buffer.from(`${body} `), b64(body), SECRET).ok).toBe(false);
  });

  test("no configured secret refuses everything", () => {
    expect(contract.verifySignature(Buffer.from(body), b64(body), "").ok).toBe(false);
  });

  test("a valid signature over malformed JSON verifies, and parsing fails after", () => {
    /* The order that matters: authenticity is a property of the BYTES, decided
       before anybody tries to understand them. */
    const bad = "{not json";
    expect(contract.verifySignature(Buffer.from(bad), b64(bad), SECRET).ok).toBe(true);
    expect(() => JSON.parse(bad)).toThrow();
  });

  test("no recoverable raw body cannot be verified", () => {
    expect(contract.verifySignature(null, b64(body), SECRET).ok).toBe(false);
    expect(contract.verifySignature(Buffer.alloc(0), b64(body), SECRET).ok).toBe(false);
  });

  test("server.js claims the webhook path before the global JSON parser", () => {
    /* Parsing untrusted input before authenticating it is work done on an
       attacker's behalf. The raw parser is mounted above the global one. */
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
    const rawAt = src.indexOf('app.use("/api/cms/marketing/events", express.raw');
    const jsonAt = src.indexOf('app.use(express.json({ limit: "50mb"');
    expect(rawAt).toBeGreaterThan(-1);
    expect(rawAt).toBeLessThan(jsonAt);
    /* And the cap is stated in both places. */
    expect(src.slice(rawAt, rawAt + 200)).toContain('limit: "1mb"');
  });
});

/* ═══ 3-6. IDEMPOTENCE, ORDERING, DETERMINISTIC IDS ════════════════════════ */

describe("Replay and ordering", () => {
  test("replaying a delivery creates one immutable event and one receipt", async () => {
    await identity();
    await ingest(P.click());
    await ingest(P.click());
    await ingest(P.click());
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
    expect(await MarketingEventReceipt.countDocuments({})).toBe(1);
  });

  test("concurrent replay still creates one immutable event", async () => {
    await identity();
    const { events } = contract.translate(P.click());
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      eventIntake.recordEvent({ companyId: COMPANY, event: events[0] })));
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });

  test("deterministic ids survive batch reordering and re-batching", () => {
    const batchA = { ...P.send(1), ...P.open(2), ...P.click(3) };
    const idsA = contract.translate(batchA).events.map((e) => e.sourceEventId).sort();

    /* The same three events, in a different key order and split differently. */
    const idsB = [
      ...contract.translate({ ...P.click(3), ...P.send(1) }).events,
      ...contract.translate(P.open(2)).events,
    ].map((e) => e.sourceEventId).sort();

    expect(idsB).toEqual(idsA);
    /* Nothing in a key depends on position or arrival. */
    for (const id of idsA) expect(id).not.toMatch(/\d{13}|index|position/);
  });

  test("a reordered batch produces the same final result", async () => {
    await identity();
    await grantConsent();
    const forward = [P.send(1), P.open(2), P.click(3), P.unsub(7)];
    for (const p of forward) await ingest(p);
    const afterForward = {
      events: await MarketingIntentEvent.countDocuments({}),
      activities: await Activity.countDocuments({}),
      consent: (await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state,
    };

    /* Same events, delivered backwards. Nothing new, nothing changed. */
    for (const p of [...forward].reverse()) await ingest(p);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(afterForward.events);
    expect(await Activity.countDocuments({})).toBe(afterForward.activities);
    expect((await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state).toBe(afterForward.consent);
  });

  test("a click before a delivery, and an open after an unsubscribe, both land", async () => {
    await identity();
    await grantConsent();
    await ingest(P.click(3, "2026-09-09T10:00:00+00:00"));
    await ingest(P.delivered(6, "2026-09-09T08:01:00+00:00"));
    await ingest(P.unsub(7, "2026-09-09T12:00:00+00:00"));
    await ingest(P.open(2, "2026-09-09T11:00:00+00:00"));

    const rows = await MarketingIntentEvent.find({}).sort({ occurredAt: 1 }).lean();
    /* Chronology is `occurredAt`, never arrival. */
    expect(rows.map((r) => r.kind)).toEqual([
      "email_delivered", "email_clicked", "email_opened", "email_unsubscribed",
    ]);
    /* And the late open did not weaken the suppression. */
    expect((await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state).toBe("suppressed");
  });

  test("an older send arriving after a newer click changes no engagement state", async () => {
    await identity();
    await grantConsent();
    await ingest(P.click(3, "2026-09-09T10:00:00+00:00"));
    const before = await Activity.countDocuments({});
    await ingest(P.send(1, "2026-09-09T07:00:00+00:00"));
    expect(await Activity.countDocuments({})).toBe(before);
  });
});

/* ═══ 7-8. THE LEDGER IS IMMUTABLE ═════════════════════════════════════════ */

describe("The ledger refuses every mutation", () => {
  test("update and delete are refused through every mongoose door", async () => {
    await identity();
    await ingest(P.click());
    const row = await MarketingIntentEvent.findOne({});
    const f = { _id: row._id };

    await expect(MarketingIntentEvent.updateOne(f, { $set: { kind: "email_opened" } })).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    await expect(MarketingIntentEvent.updateMany({}, { $set: { kind: "email_opened" } })).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    await expect(MarketingIntentEvent.findOneAndUpdate(f, { $set: { email: "x@y.in" } })).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    await expect(MarketingIntentEvent.replaceOne(f, { kind: "email_opened" })).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    await expect(MarketingIntentEvent.deleteOne(f)).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    await expect(MarketingIntentEvent.deleteMany({})).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    await expect(MarketingIntentEvent.findOneAndDelete(f)).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);

    row.kind = "email_opened";
    await expect(row.save()).rejects.toThrow(EVENT_IMMUTABLE_MESSAGE);
    expect((await MarketingIntentEvent.findById(row._id).lean()).kind).toBe("email_clicked");
  });

  test("workflow state lands on the receipt, never on the observation", async () => {
    await identity();
    await ingest(P.form());
    const row = await MarketingIntentEvent.findOne({}).lean();
    /* The field that used to be edited onto recorded events. */
    expect(row.usedInHandoverRef).toBeUndefined();

    await eventIntake.markUsedInHandover({
      companyId: COMPANY, sourceEventIds: [row.sourceEventId], handoverRef: "MHO-2026-0001",
    });
    expect((await MarketingEventReceipt.findOne({}).lean()).usedInHandoverRef).toBe("MHO-2026-0001");
    expect((await MarketingIntentEvent.findOne({}).lean()).usedInHandoverRef).toBeUndefined();
  });

  test("the replay key is company-scoped, so two companies cannot collide", async () => {
    const { events } = contract.translate(P.click());
    const a = await eventIntake.recordEvent({ companyId: COMPANY, event: events[0] });
    const b = await eventIntake.recordEvent({ companyId: OTHER_COMPANY, event: events[0] });
    /* Both recorded. A global key would have swallowed the second company's
       first event as a duplicate of the first company's. */
    expect(a.recorded).toBe(true);
    expect(b.recorded).toBe(true);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(2);
  });

  test("no credential, header, cookie or unbounded body reaches the ledger", async () => {
    await identity();
    await ingest(P.form());
    const row = await MarketingIntentEvent.findOne({}).lean();
    const s = JSON.stringify(row);
    expect(row.raw).toBeUndefined();
    expect(s).not.toContain("authorization");
    expect(s).not.toContain("cookie");
    /* The EVIDENCE carries field keys, never the answers behind them. */
    expect(row.evidence.resultKeys).toEqual(expect.arrayContaining(["email", "product_interest"]));
    expect(JSON.stringify(row.evidence)).not.toContain("housekeeping uniforms");
    /* `topics` is a separate, deliberate, bounded extraction that the handover
       package depends on — a stated product interest, not a copy of the form. */
    expect(row.topics).toEqual(["housekeeping uniforms"]);
    /* The whole row stays small. The item it came from was over 8 KB. */
    expect(s.length).toBeLessThan(2000);
  });
});

/* ═══ 9-11. IDENTITY RESOLUTION ════════════════════════════════════════════ */

describe("Identity resolution", () => {
  test("the company-scoped external mapping resolves first", async () => {
    await identity();
    const { events } = contract.translate(P.click());
    const r = await engagement.resolveIdentity({ companyId: COMPANY, event: events[0] });
    expect(r).toMatchObject({ gravPersonKey: KEY, resolvedBy: "external_mapping" });
  });

  test("an exact company-scoped email match resolves when no mapping exists", async () => {
    await MarketingIdentity.create({ companyId: COMPANY, gravPersonKey: KEY, email: EMAIL });
    const { events } = contract.translate(P.click());
    const r = await engagement.resolveIdentity({ companyId: COMPANY, event: events[0] });
    expect(r).toMatchObject({ gravPersonKey: KEY, resolvedBy: "canonical_identity" });
  });

  test("another company's identity cannot resolve", async () => {
    await MarketingIdentity.create({
      companyId: OTHER_COMPANY, gravPersonKey: KEY, email: EMAIL,
      externals: [{ system: "mautic", externalId: CONTACT_ID, proven: true }],
    });
    const { events } = contract.translate(P.click());
    const r = await engagement.resolveIdentity({ companyId: COMPANY, event: events[0] });
    expect(r).toMatchObject({ gravPersonKey: "", resolvedBy: "unresolved" });
  });

  test("an unresolved event stays visible and creates no Sales record", async () => {
    const { results } = await ingest(P.click());
    expect(results[0].receipt.state).toBe("IDENTITY_UNRESOLVED");

    const health = await api("/data-health/engagement");
    expect(health.status).toBe(200);
    expect(health.body.records).toHaveLength(1);
    expect(health.body.records[0]).toMatchObject({ state: "IDENTITY_UNRESOLVED", gravPersonKey: null });

    for (const M of [Lead, Contact, Account, Enquiry, SalesJourney, Activity]) {
      expect(await M.countDocuments({})).toBe(0);
    }
  });

  test("late resolution updates the receipt and rewrites no observation", async () => {
    const { results } = await ingest(P.form());
    const before = await MarketingIntentEvent.findOne({}).lean();
    expect(results[0].receipt.state).toBe("IDENTITY_UNRESOLVED");
    expect(before.gravPersonKey).toBe("");

    await identity();
    await engagement.processEvent({ companyId: COMPANY, event: before });

    expect((await MarketingEventReceipt.findOne({}).lean()).gravPersonKey).toBe(KEY);
    /* The observation is byte-identical: it records what was known then. */
    expect(await MarketingIntentEvent.findOne({}).lean()).toEqual(before);
  });
});

/* ═══ 12-16. SUPPRESSION ═══════════════════════════════════════════════════ */

describe("Suppression is immediate, idempotent and conservative", () => {
  test("an unsubscribe suppresses once, however many times it is replayed", async () => {
    await identity();
    await grantConsent();
    await ingest(P.unsub());
    await ingest(P.unsub());
    await ingest(P.unsub());

    const consent = await MarketingConsent.findOne({ gravPersonKey: KEY }).lean();
    expect(consent.state).toBe("suppressed");
    const { MarketingConsentHistory } = require("../../models/CMS_Models/Marketing/MarketingConsent");
    /* The grant plus exactly one suppression. */
    expect(await MarketingConsentHistory.countDocuments({})).toBe(2);
    const receipt = await MarketingEventReceipt.findOne({}).lean();
    /* The suppression is done. The headline reports the Activity still owed —
       this person has no linked Sales record — and the two do not contradict. */
    expect(receipt.suppression.state).toBe("applied");
    expect(receipt.state).toBe("ACTIVITY_PENDING");
  });

  test("a hard bounce suppresses once", async () => {
    await identity();
    await grantConsent();
    await ingest(P.bounce());
    await ingest(P.bounce());
    const consent = await MarketingConsent.findOne({ gravPersonKey: KEY }).lean();
    expect(consent.state).toBe("suppressed");
    expect(consent.withdrawalReason).toContain("Hard bounce");
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });

  test("a soft bounce is recorded and never suppresses", async () => {
    await identity();
    await grantConsent();
    await ingest(P.bounce(9, "452 4.2.2 mailbox full"));
    expect((await MarketingIntentEvent.findOne({}).lean()).bounceClass).toBe("soft");
    /* The person is still opted in — a full mailbox on a Tuesday is not a
       reason to delete somebody from every future campaign. */
    expect((await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state).toBe("opted_in");
  });

  test("an unclassifiable bounce suppresses for review without claiming a hard bounce", async () => {
    await identity();
    await grantConsent();
    await ingest(P.bounce(10, "the server said something odd"));
    const consent = await MarketingConsent.findOne({ gravPersonKey: KEY }).lean();
    expect(consent.state).toBe("suppressed");
    expect(consent.withdrawalReason).toContain("NOT a confirmed hard bounce");
    expect((await MarketingIntentEvent.findOne({}).lean()).bounceClass).toBe("unknown");
  });

  test("suppression beats every later open, click and delivery", async () => {
    await identity();
    await grantConsent();
    await ingest(P.unsub());
    await ingest(P.open());
    await ingest(P.click());
    await ingest(P.delivered());
    expect((await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state).toBe("suppressed");
  });

  test("a suppression failure stays visible and retryable, and is not called done", async () => {
    await identity();
    await grantConsent();
    const spy = jest.spyOn(consentService, "suppress").mockRejectedValueOnce(new Error("consent store unavailable"));

    const { results } = await ingest(P.unsub());
    expect(results[0].receipt.state).toBe("SUPPRESSION_FAILED");
    /* Not suppressed yet — and the receipt says so rather than reading RECORDED. */
    expect((await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state).toBe("opted_in");

    const health = await api("/data-health/engagement?state=SUPPRESSION_FAILED");
    expect(health.body.records[0].suppression.error).toContain("consent store unavailable");

    spy.mockRestore();
    await engagement.resumeUnfinished({ companyId: COMPANY });

    /* The suppression is now applied. The receipt's headline moves on to the
       Activity still owed — this person has no linked Sales record — which is a
       different, non-urgent kind of outstanding, and the suppression sub-state
       is what says the withdrawal was honoured. */
    const after = await MarketingEventReceipt.findOne({}).lean();
    expect(after.suppression.state).toBe("applied");
    expect(after.suppression.error).toBe("");
    expect(after.state).not.toBe("SUPPRESSION_FAILED");
    expect((await MarketingConsent.findOne({ gravPersonKey: KEY }).lean()).state).toBe("suppressed");
  });

  test("the suppression command key is derived from the event, so replay is idempotent", async () => {
    const { events } = contract.translate(P.unsub());
    const a = engagement.suppressionCommandKey(events[0]);
    const b = engagement.suppressionCommandKey(contract.translate(P.unsub()).events[0]);
    expect(a).toBe(b);
    expect(a).not.toBe(engagement.suppressionCommandKey(contract.translate(P.unsub(99)).events[0]));
  });

  test("a suppressed person cannot afterwards be projected into Mautic", async () => {
    await identity();
    await grantConsent();
    await ingest(P.unsub());
    const verdict = await consentService.resolveEffective({
      companyId: COMPANY, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
    });
    expect(verdict).toMatchObject({ eligible: false, reasonCode: "CONSENT_SUPPRESSED" });
  });
});

/* ═══ 17-21. CRM ACTIVITY PROJECTION ═══════════════════════════════════════ */

describe("Only useful milestones reach the Sales timeline", () => {
  async function linkedLead() {
    const lead = await createWithRef(Lead, {
      companyId: COMPANY, company: "Aurora Hotels", firstName: "Meera",
      captureStatus: "draft", isActive: true,
    });
    await identity({ salesLeadId: lead._id });
    return lead;
  }

  test("an explicit request creates exactly one Activity, however often replayed", async () => {
    const lead = await linkedLead();
    await ingest(P.form());
    await ingest(P.form());
    await ingest(P.form());

    const acts = await Activity.find({}).lean();
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      activityType: "email_log",
      leadId: lead._id,
      marketingSourceEventId: "mautic.form_on_submit:submission:5",
      status: "completed",
    });
    /* ── THE PROVENANCE SYSTEM IS STORED BUT NOT SELECTED ──────────────────
       The Sales activity routes spread the whole document into the response, so
       a selectable field naming the marketing provider would appear on a
       salesperson's timeline. It stays in the database — the projection's
       uniqueness index is built on it — and off the wire. */
    expect(acts[0]).not.toHaveProperty("marketingSource");
    const withProvenance = await Activity.findById(acts[0]._id).select("+marketingSource").lean();
    expect(withProvenance.marketingSource).toBe("mautic");
    expect(acts[0].subject).toContain("submitted Uniform guide");
    /* The EVENT's time, not the webhook's. */
    expect(acts[0].activityDate.toISOString()).toBe("2026-09-09T11:00:00.000Z");
    /* No payload, no marketing noise. */
    expect(JSON.stringify(acts[0])).not.toContain("housekeeping uniforms");
  });

  test("concurrent replay still creates exactly one Activity", async () => {
    await linkedLead();
    const { events } = contract.translate(P.click());
    const r = await eventIntake.recordEvent({ companyId: COMPANY, event: events[0] });
    const row = await MarketingIntentEvent.findById(r.eventId).lean();
    await Promise.all([1, 2, 3].map(() => engagement.processEvent({ companyId: COMPANY, event: row })));
    expect(await Activity.countDocuments({})).toBe(1);
  });

  test("delivery telemetry and repetitive opens create no Activity at all", async () => {
    await linkedLead();
    await ingest(P.send(1));
    await ingest(P.delivered(6));
    await ingest(P.open(2));
    await ingest(P.open(20, "2026-09-09T09:30:00+00:00"));
    await ingest(P.open(21, "2026-09-09T09:45:00+00:00"));
    await ingest(P.view(4));

    expect(await MarketingIntentEvent.countDocuments({})).toBe(6);
    /* Six observations, nothing on the timeline. */
    expect(await Activity.countDocuments({})).toBe(0);
    const receipts = await MarketingEventReceipt.find({}).lean();
    expect(receipts.every((r) => r.activity.state === "not_applicable")).toBe(true);
    expect(receipts.filter((r) => r.state === "IGNORED").length).toBeGreaterThan(0);
  });

  test("unsubscribe and hard bounce are projected; a soft bounce is not", async () => {
    await linkedLead();
    await grantConsent();
    await ingest(P.unsub());
    await ingest(P.bounce(11, "452 4.2.2 mailbox full"));

    const acts = await Activity.find({}).sort({ activityDate: 1 }).lean();
    expect(acts).toHaveLength(1);
    expect(acts[0].subject).toContain("unsubscribed");
  });

  test("no linked Sales record means no Activity and no invented entity", async () => {
    await identity();           // marketing identity, but no salesLeadId
    const { results } = await ingest(P.form());
    expect(await Activity.countDocuments({})).toBe(0);
    expect(results[0].receipt.state).toBe("ACTIVITY_PENDING");
    expect(results[0].receipt.activity.error).toContain("No canonical Sales record");

    for (const M of [Lead, Contact, Account, Enquiry, SalesJourney]) {
      expect(await M.countDocuments({})).toBe(0);
    }
  });

  test("a pending projection completes once the person is linked, without a second event", async () => {
    await identity();
    await ingest(P.form());
    expect(await Activity.countDocuments({})).toBe(0);

    const lead = await createWithRef(Lead, {
      companyId: COMPANY, company: "Aurora Hotels", firstName: "Meera", captureStatus: "draft", isActive: true,
    });
    await MarketingIdentity.updateOne({ gravPersonKey: KEY }, { $set: { salesLeadId: lead._id } });

    const resumed = await engagement.resumeUnfinished({ companyId: COMPANY });
    expect(resumed.resolved).toBe(1);
    expect(await Activity.countDocuments({})).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });

  test("a Lead in another company is not a link", async () => {
    const foreign = await createWithRef(Lead, {
      companyId: OTHER_COMPANY, company: "Someone else", firstName: "X", captureStatus: "draft", isActive: true,
    });
    await identity({ salesLeadId: foreign._id });
    await ingest(P.form());
    expect(await Activity.countDocuments({})).toBe(0);
  });

  test("no Marketing path changes a Lead's lifecycle", async () => {
    const lead = await linkedLead();
    const before = await Lead.findById(lead._id).lean();
    await grantConsent();
    for (const p of [P.send(), P.open(), P.click(), P.form(), P.unsub(), P.bounce()]) await ingest(p);

    const after = await Lead.findById(lead._id).lean();
    expect(after.captureStatus).toBe(before.captureStatus);
    expect(after.reviewStatus).toBe(before.reviewStatus);
    expect(after.qualificationState).toBe(before.qualificationState);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("the projection allowlist names what may reach the timeline", () => {
    const allowed = Object.keys(projection.PROJECTABLE).sort();
    expect(allowed).toEqual([
      "callback_requested", "consultation_requested", "email_bounced",
      "email_clicked", "email_unsubscribed", "form_submitted",
      "quotation_requested", "sample_requested",
    ]);
    /* The four telemetry kinds are absent by design. */
    for (const k of ["email_sent", "email_delivered", "email_opened", "page_viewed"]) {
      expect(allowed).not.toContain(k);
    }
  });
});

/* ═══ DATA HEALTH STAYS ADDITIVE FOR LANE B ════════════════════════════════ */

describe("Data Health keeps its existing shape", () => {
  test("the engagement backlog is added without changing what Lane B reads", async () => {
    await identity();
    await ingest(P.click());
    const res = await api("/data-health");
    expect(res.status).toBe(200);
    /* The keys Lane B already renders. */
    for (const k of ["counts", "reasonCounts", "totals", "retry", "blocked", "lastSuccessfulSyncAt", "vocabulary", "complete"]) {
      expect(res.body).toHaveProperty(k);
    }
    /* And the new one it does not read yet. */
    expect(res.body.engagement).toMatchObject({ eventsProcessed: 1, unfinishedTotal: 1 });
    /* The person resolved, so what is outstanding is the timeline entry: there
       is no Sales record to attach it to, and Marketing will not invent one. */
    expect(res.body.engagement.unfinished.ACTIVITY_PENDING).toBe(1);
    expect(res.body.engagement.unfinished.IDENTITY_UNRESOLVED).toBe(0);
    expect(res.body.engagement.lastEventOccurredAt).toBe("2026-09-09T10:00:00.000Z");
  });

  test("an unknown engagement state is a clean 400", async () => {
    const res = await api("/data-health/engagement?state=NONSENSE");
    expect(res.status).toBe(400);
    expect(res.body.error.details.accepted).toEqual(MarketingEventReceipt.UNFINISHED_STATES);
  });

  test("it refuses an unauthenticated caller", async () => {
    const r = await fetch(`${base}/data-health/engagement`);
    expect(r.status).toBe(401);
  });
});
