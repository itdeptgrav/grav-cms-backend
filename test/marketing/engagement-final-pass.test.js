// test/marketing/engagement-final-pass.test.js
//
// THE FINAL FOUR CORRECTIONS, EACH PROVED BY THE FAILURE IT PREVENTS.
//
// Every test reproduces a way the previous pass was still wrong, so each fails
// loudly if the correction is undone.
"use strict";

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
const consentService = require("../../services/marketing/marketingConsent.service");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingConsent, MarketingConsentHistory } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { createWithRef } = require("../../services/leadRef");

const KEY = "grav-person-final-1";
const EMAIL = "meera@aurorahotels.in";
const CONTACT_ID = "44";
const EMAIL_PURPOSE = consentService.MARKETING_EMAIL;

let COMPANY_A;
let COMPANY_B;
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
  const a = await Acc_Company.create({ companyName: "GRAV A", booksFromDate: new Date("2026-04-01") });
  COMPANY_A = a._id;
  COMPANY_B = new mongoose.Types.ObjectId();
  await Activity.syncIndexes();
  await MarketingConsentHistory.syncIndexes();
});

const api = async (path) => {
  const r = await fetch(`${base}${path}`, { headers: { "x-test-user": JSON.stringify(MARKETER) } });
  return { status: r.status, body: await r.json() };
};

const leadBlock = () => ({ id: Number(CONTACT_ID), fields: { core: { email: { value: EMAIL } } } });
const unsubPayload = (dncId = 7, at = "2026-09-09T12:00:00+00:00") => ({
  "mautic.lead_channel_subscription_changed": [{
    contact: { ...leadBlock(), doNotContact: [{ id: dncId, channel: "email", comments: "", dateAdded: at }] },
    channel: "email", old_status: "contactable", new_status: "unsubscribed", timestamp: at,
  }],
});
const bouncePayload = (dncId = 8, at = "2026-09-09T13:00:00+00:00") => ({
  "mautic.lead_channel_subscription_changed": [{
    contact: { ...leadBlock(), doNotContact: [{ id: dncId, channel: "email", comments: "550 5.1.1 User unknown", dateAdded: at }] },
    channel: "email", old_status: "contactable", new_status: "bounced", timestamp: at,
  }],
});

const identityIn = (companyId, over = {}) => MarketingIdentity.create({
  companyId, gravPersonKey: KEY, email: EMAIL,
  externals: [{ system: "mautic", externalId: CONTACT_ID, proven: true }],
  ...over,
});
const grantIn = (companyId) => consentService.record({
  companyId, gravPersonKey: KEY, ...EMAIL_PURPOSE,
  state: "opted_in", capturedSource: "test", actor: { name: "T" },
});
const leadIn = (companyId) => createWithRef(Lead, {
  companyId, company: "Aurora", firstName: "Meera", captureStatus: "draft", isActive: true,
});

async function ingestIn(companyId, payload) {
  const { events } = contract.translate(payload);
  const out = [];
  for (const e of events) {
    const r = await eventIntake.recordEvent({ companyId, event: e });
    const row = await MarketingIntentEvent.findById(r.eventId).lean();
    out.push({ r, row, receipt: row ? await engagement.processEvent({ companyId, event: row }) : null });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. SUPPRESSION GATES THE ACTIVITY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A suppression claim never reaches the timeline before it is true", () => {
  test("a failed consent write leaves no Activity, then recovery writes exactly one", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await grantIn(COMPANY_A);

    const spy = jest.spyOn(consentService, "suppress").mockRejectedValueOnce(new Error("consent store down"));
    const [{ receipt }] = await ingestIn(COMPANY_A, unsubPayload(7));
    spy.mockRestore();

    expect(receipt.state).toBe("SUPPRESSION_FAILED");
    /* THE POINT. The old code wrote "Marketing: unsubscribed from marketing
       email" onto the Sales timeline while consent still said opted in — a
       claim the next campaign would have contradicted. */
    expect(await Activity.countDocuments({})).toBe(0);
    expect(receipt.activity.state).toBeFalsy();
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("opted_in");

    /* Recovery: suppression first, then exactly one Activity. */
    const resumed = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(resumed.resolved).toBe(1);
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("suppressed");
    expect(await Activity.countDocuments({})).toBe(1);
    expect((await Activity.findOne({}).lean()).subject).toContain("unsubscribed");
  });

  test("replaying after recovery duplicates neither consent history nor Activity", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await grantIn(COMPANY_A);

    const spy = jest.spyOn(consentService, "suppress").mockRejectedValueOnce(new Error("down"));
    await ingestIn(COMPANY_A, unsubPayload(7));
    spy.mockRestore();
    await engagement.resumeUnfinished({ companyId: COMPANY_A });

    const historyAfterRecovery = await MarketingConsentHistory.countDocuments({});
    for (let i = 0; i < 3; i++) await ingestIn(COMPANY_A, unsubPayload(7));

    expect(await MarketingConsentHistory.countDocuments({})).toBe(historyAfterRecovery);
    expect(await Activity.countDocuments({})).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });

  test("a suppressing bounce is gated the same way", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await grantIn(COMPANY_A);

    const spy = jest.spyOn(consentService, "suppress").mockRejectedValueOnce(new Error("down"));
    const [{ receipt }] = await ingestIn(COMPANY_A, bouncePayload(8));
    spy.mockRestore();

    expect(receipt.state).toBe("SUPPRESSION_FAILED");
    expect(await Activity.countDocuments({})).toBe(0);

    await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(await Activity.countDocuments({})).toBe(1);
  });

  test("a non-suppressing event is not gated", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await ingestIn(COMPANY_A, {
      "mautic.form_on_submit": [{
        submission: { id: 5, dateSubmitted: "2026-09-09T11:00:00+00:00", form: { id: 3, name: "Guide" }, results: {}, lead: leadBlock() },
        timestamp: "2026-09-09T11:00:00+00:00",
      }],
    });
    expect(await Activity.countDocuments({})).toBe(1);
  });

  test("projected wording is historical, never a present-tense suppression claim", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await grantIn(COMPANY_A);
    await ingestIn(COMPANY_A, bouncePayload(8));

    const act = await Activity.findOne({}).lean();
    expect(act.subject).toBe("Marketing: email address hard-bounced");
    /* A dated row is never re-read when the world moves on, so it must not
       assert a present state that may since have changed. */
    expect(act.subject).not.toMatch(/is suppressed|is currently|cannot be emailed/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. EVERY RECOVERY LOOKUP CARRIES THE COMPLETE IDENTITY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A corrupted receipt cannot reach another company's event", () => {
  test("company A recovery reads, processes and changes nothing of company B's", async () => {
    /* Company B has a real, unprocessed unsubscribe and a person to suppress. */
    await identityIn(COMPANY_B);
    await grantIn(COMPANY_B);
    const { events } = contract.translate(unsubPayload(7));
    const bEvent = await MarketingIntentEvent.create({ ...events[0], companyId: COMPANY_B, evidence: {} });

    /* Company A holds a receipt pointing at B's event — the corruption. */
    await MarketingEventReceipt.create({
      companyId: COMPANY_A, source: "mautic", sourceEventId: events[0].sourceEventId,
      eventId: bEvent._id, kind: events[0].kind, occurredAt: events[0].occurredAt,
      state: "IDENTITY_UNRESOLVED",
    });

    const before = {
      consent: (await MarketingConsent.findOne({ companyId: COMPANY_B }).lean()).state,
      receipts: await MarketingEventReceipt.countDocuments({ companyId: COMPANY_B }),
      activities: await Activity.countDocuments({}),
    };

    const out = await engagement.resumeUnfinished({ companyId: COMPANY_A });

    /* Nothing of B's was touched. */
    expect((await MarketingConsent.findOne({ companyId: COMPANY_B }).lean()).state).toBe(before.consent);
    expect(await MarketingEventReceipt.countDocuments({ companyId: COMPANY_B })).toBe(before.receipts);
    expect(await Activity.countDocuments({})).toBe(before.activities);

    /* And the inconsistency is visible rather than silently skipped. */
    expect(out.stillPending).toBe(1);
    expect(out.resolved).toBe(0);
    expect(out.integrity).toEqual([{
      sourceEventId: events[0].sourceEventId,
      reason: "The receipt points at no observation belonging to this company.",
    }]);
  });

  test("normal same-company recovery still succeeds", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await grantIn(COMPANY_A);

    const spy = jest.spyOn(consentService, "suppress").mockRejectedValueOnce(new Error("down"));
    await ingestIn(COMPANY_A, unsubPayload(7));
    spy.mockRestore();

    const out = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(out.resolved).toBe(1);
    expect(out.integrity).toEqual([]);
  });

  test("a receipt whose source event id has drifted is refused too", async () => {
    await identityIn(COMPANY_A);
    const { events } = contract.translate(unsubPayload(7));
    const event = await MarketingIntentEvent.create({ ...events[0], companyId: COMPANY_A, evidence: {} });
    await MarketingEventReceipt.create({
      companyId: COMPANY_A, source: "mautic", sourceEventId: "some:other:key",
      eventId: event._id, kind: events[0].kind, occurredAt: events[0].occurredAt,
      state: "IDENTITY_UNRESOLVED",
    });

    const out = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(out.resolved).toBe(0);
    expect(out.integrity).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. A SUPERSEDED COMMAND IS SETTLED, NOT FAILED FOR EVER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A legitimately superseded suppression", () => {
  /** Suppression in history, then a genuine later opt-in as the current state. */
  async function supersededSetup(companyId) {
    await grantIn(companyId);
    const { events } = contract.translate(unsubPayload(7));
    const commandKey = engagement.suppressionCommandKey(events[0]);
    await consentService.suppress({
      companyId, gravPersonKey: KEY, ...EMAIL_PURPOSE,
      reason: "unsubscribed", actor: null, commandKey,
    });
    await consentService.record({
      companyId, gravPersonKey: KEY, ...EMAIL_PURPOSE,
      state: "opted_in", capturedSource: "came back via the website",
      actor: { name: "Marketer" }, commandKey: "later-opt-in",
    });
    return { commandKey, events };
  }

  test("the consent service reports superseded explicitly", async () => {
    const { commandKey } = await supersededSetup(COMPANY_A);
    const out = await consentService.suppress({
      companyId: COMPANY_A, gravPersonKey: KEY, ...EMAIL_PURPOSE,
      reason: "unsubscribed", actor: null, commandKey,
    });

    expect(out).toMatchObject({ duplicate: true, superseded: true, settled: true, reflected: false });
    expect(out.currentState).toBe("opted_in");
    expect(out.supersededBy).toMatchObject({ state: "opted_in" });
    /* The newer decision stands. */
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("opted_in");
  });

  test("processing settles it rather than failing for ever", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await supersededSetup(COMPANY_A);

    const historyBefore = await MarketingConsentHistory.countDocuments({});
    const [{ receipt }] = await ingestIn(COMPANY_A, unsubPayload(7));

    expect(receipt.suppression.state).toBe("superseded");
    expect(receipt.state).toBe("SUPPRESSION_SUPERSEDED");
    /* Evidence of WHAT replaced it, so nobody reads this as a lost suppression. */
    expect(receipt.suppression.supersededByState).toBe("opted_in");
    expect(receipt.suppression.supersededByRevision).toBeGreaterThan(0);

    /* The newer decision was not overwritten, and no history was added. */
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("opted_in");
    expect(await MarketingConsentHistory.countDocuments({})).toBe(historyBefore);
  });

  test("it does not re-enter resumeUnfinished for ever", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await supersededSetup(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));

    /* SUPPRESSION_SUPERSEDED is not an unfinished state, so nothing keeps
       picking it up. */
    expect(MarketingEventReceipt.UNFINISHED_STATES).not.toContain("SUPPRESSION_SUPERSEDED");
    const first = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    const second = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(first.considered).toBe(0);
    expect(second.considered).toBe(0);
  });

  test("it does not claim the person is currently suppressed", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await supersededSetup(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));

    const verdict = await consentService.resolveEffective({
      companyId: COMPANY_A, gravPersonKey: KEY, ...EMAIL_PURPOSE,
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.state).toBe("opted_in");

    /* Any projected row describes the EVENT, in the past, and asserts nothing
       about the present. */
    const act = await Activity.findOne({}).lean();
    if (act) {
      expect(act.subject).toBe("Marketing: unsubscribed from marketing email");
      expect(act.subject).not.toMatch(/is suppressed|is currently/i);
    }
  });

  test("replaying it repeatedly creates no duplicate history or Activity", async () => {
    const lead = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await supersededSetup(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));

    const history = await MarketingConsentHistory.countDocuments({});
    const activities = await Activity.countDocuments({});
    for (let i = 0; i < 3; i++) await ingestIn(COMPANY_A, unsubPayload(7));

    expect(await MarketingConsentHistory.countDocuments({})).toBe(history);
    expect(await Activity.countDocuments({})).toBe(activities);
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("opted_in");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE ORPHAN CAP IS HONEST
   ═══════════════════════════════════════════════════════════════════════════ */

describe("The missing-receipt count says when it is capped", () => {
  /** `n` ledger events with no receipts. */
  async function orphans(companyId, n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        companyId, source: "mautic", sourceEventId: `orphan:${i}`, kind: "form_submitted",
        externalContactId: CONTACT_ID, email: EMAIL, occurredAt: new Date(), evidence: {},
      });
    }
    await MarketingIntentEvent.insertMany(rows);
  }

  test("499 reports 499 and not capped", async () => {
    await orphans(COMPANY_A, 499);
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A }))
      .toEqual({ count: 499, capped: false });
  });

  test("exactly 500 reports 500 and not capped", async () => {
    await orphans(COMPANY_A, 500);
    /* The distinction the limit-plus-one query exists to make: this is the
       answer, not the ceiling. */
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A }))
      .toEqual({ count: 500, capped: false });
  });

  test("501 reports 500 and capped, meaning at least 500", async () => {
    await orphans(COMPANY_A, 501);
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A }))
      .toEqual({ count: 500, capped: true });
  });

  test("Data Health carries the capped flag", async () => {
    await orphans(COMPANY_A, 501);
    const res = await api("/data-health");
    expect(res.status).toBe(200);
    expect(res.body.engagement.missingReceipts).toBe(500);
    expect(res.body.engagement.missingReceiptsCapped).toBe(true);
  });

  test("company isolation holds at the cap", async () => {
    await orphans(COMPANY_B, 501);
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A }))
      .toEqual({ count: 0, capped: false });
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_B }))
      .toEqual({ count: 500, capped: true });
  });

  test("the cap is configurable, and the boundary logic holds at any cap", async () => {
    await orphans(COMPANY_A, 11);
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A, cap: 10 }))
      .toEqual({ count: 10, capped: true });
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A, cap: 11 }))
      .toEqual({ count: 11, capped: false });
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A, cap: 20 }))
      .toEqual({ count: 11, capped: false });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   BOUNDARIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Boundaries this pass must not have moved", () => {
  test("no Sales lifecycle entity is created or changed", async () => {
    const lead = await leadIn(COMPANY_A);
    const before = await Lead.findById(lead._id).lean();
    await identityIn(COMPANY_A, { salesLeadId: lead._id });
    await grantIn(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));
    await engagement.resumeUnfinished({ companyId: COMPANY_A });
    await engagement.recoverMissingReceipts({ companyId: COMPANY_A });

    const after = await Lead.findById(lead._id).lean();
    expect(after.captureStatus).toBe(before.captureStatus);
    expect(after.reviewStatus).toBe(before.reviewStatus);
    expect(after.qualificationState).toBe(before.qualificationState);
    expect(await Lead.countDocuments({})).toBe(1);
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("the ledger is still immutable", async () => {
    await identityIn(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));
    const row = await MarketingIntentEvent.findOne({});
    await expect(MarketingIntentEvent.updateOne({ _id: row._id }, { $set: { kind: "email_opened" } })).rejects.toThrow();
    await expect(MarketingIntentEvent.deleteOne({ _id: row._id })).rejects.toThrow();
  });
});
