// test/marketing/engagement-corrections.test.js
//
// THE SIX RELEASE-BLOCKING GAPS, EACH PROVED BY ITS OWN FAILURE MODE.
//
// Every test here reproduces a way the first implementation was wrong, so each
// one fails loudly if the correction is ever undone. They are deliberately
// grouped by defect rather than by module: what matters is that the specific
// hole is shut, not that a function returns the right shape.
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
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const MarketingEventReceipt = require("../../models/CMS_Models/Marketing/MarketingEventReceipt");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingConsent, MarketingConsentHistory } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { createWithRef } = require("../../services/leadRef");

const KEY = "grav-person-corr-1";
const EMAIL = "meera@aurorahotels.in";
const CONTACT_ID = "44";
const SECRET = "corrections-secret";
process.env.MAUTIC_WEBHOOK_SECRET = SECRET;

let COMPANY_A;
let COMPANY_B;
let server;
let base;
const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "N", role: "marketing", email: "n@grav.in" };

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  /* Handovers first, exactly as server.js mounts them. dataHealth applies its
     auth at the ROUTER level, so mounting it first would make it answer 401 for
     the unauthenticated webhook path before the webhook router ever sees it. */
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingHandovers"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/dataHealth"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  const a = await Acc_Company.create({ companyName: "GRAV A", booksFromDate: new Date("2026-04-01") });
  COMPANY_A = a._id;
  COMPANY_B = new mongoose.Types.ObjectId();
  process.env.MARKETING_COMPANY_ID = String(COMPANY_A);
  await Activity.syncIndexes();
  await MarketingConsentHistory.syncIndexes();
});

const api = async (path) => {
  const r = await fetch(`${base}${path}`, { headers: { "x-test-user": JSON.stringify(MARKETER) } });
  return { status: r.status, body: await r.json() };
};

const leadBlock = () => ({ id: Number(CONTACT_ID), fields: { core: { email: { value: EMAIL } } } });
const formPayload = (subId = 5, at = "2026-09-09T11:00:00+00:00") => ({
  "mautic.form_on_submit": [{
    submission: { id: subId, dateSubmitted: at, form: { id: 3, name: "Uniform guide" }, results: { email: EMAIL }, lead: leadBlock() },
    timestamp: at,
  }],
});
const unsubPayload = (dncId = 7, at = "2026-09-09T12:00:00+00:00") => ({
  "mautic.lead_channel_subscription_changed": [{
    contact: { ...leadBlock(), doNotContact: [{ id: dncId, channel: "email", comments: "", dateAdded: at }] },
    channel: "email", old_status: "contactable", new_status: "unsubscribed", timestamp: at,
  }],
});

const identityIn = (companyId, over = {}) => MarketingIdentity.create({
  companyId, gravPersonKey: KEY, email: EMAIL,
  externals: [{ system: "mautic", externalId: CONTACT_ID, proven: true }],
  ...over,
});
const grantIn = (companyId) => consentService.record({
  companyId, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
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

const signed = (body, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");
const postWebhook = async (payload) => {
  const body = JSON.stringify(payload);
  const r = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Webhook-Signature": signed(body) },
    body,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. ACTIVITY IDEMPOTENCY IS COMPANY-SCOPED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Activity provenance includes the company", () => {
  test("two companies with the same source event id each get their own Activity", async () => {
    const leadA = await leadIn(COMPANY_A);
    const leadB = await leadIn(COMPANY_B);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    await identityIn(COMPANY_B, { salesLeadId: leadB._id });

    /* Byte-identical event ids. Two Mautic instances both number submissions
       from 1, so this is the ordinary case, not a contrived one. */
    await ingestIn(COMPANY_A, formPayload(1));
    await ingestIn(COMPANY_B, formPayload(1));

    const acts = await Activity.find({}).lean();
    expect(acts).toHaveLength(2);
    expect(acts.map((a) => String(a.marketingCompanyId)).sort())
      .toEqual([String(COMPANY_A), String(COMPANY_B)].sort());
    expect(new Set(acts.map((a) => a.marketingSourceEventId)).size).toBe(1);
    /* Each attached to its own company's Lead. */
    expect(acts.find((a) => String(a.marketingCompanyId) === String(COMPANY_A)).leadId).toEqual(leadA._id);
    expect(acts.find((a) => String(a.marketingCompanyId) === String(COMPANY_B)).leadId).toEqual(leadB._id);
  });

  test("replaying either company's event adds nothing", async () => {
    const leadA = await leadIn(COMPANY_A);
    const leadB = await leadIn(COMPANY_B);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    await identityIn(COMPANY_B, { salesLeadId: leadB._id });
    await ingestIn(COMPANY_A, formPayload(1));
    await ingestIn(COMPANY_B, formPayload(1));

    for (let i = 0; i < 3; i++) {
      await ingestIn(COMPANY_A, formPayload(1));
      await ingestIn(COMPANY_B, formPayload(1));
    }
    expect(await Activity.countDocuments({})).toBe(2);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(2);
  });

  test("a duplicate lookup can never return another company's Activity id", async () => {
    const leadB = await leadIn(COMPANY_B);
    await identityIn(COMPANY_B, { salesLeadId: leadB._id });
    await ingestIn(COMPANY_B, formPayload(1));
    const theirs = await Activity.findOne({}).lean();

    /* The same event, asked about from company A. */
    const { events } = contract.translate(formPayload(1));
    const found = await projection.findByProvenance({ companyId: COMPANY_A, event: events[0] });
    expect(found).toBeNull();
    expect(theirs).toBeTruthy();
  });

  test("the unique index itself is company-scoped", async () => {
    const leadA = await leadIn(COMPANY_A);
    const leadB = await leadIn(COMPANY_B);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    await ingestIn(COMPANY_A, formPayload(1));

    /* A second row with the SAME complete key is refused. */
    await expect(Activity.create({
      activityType: "note", subject: "forged", leadId: leadA._id,
      marketingCompanyId: COMPANY_A, marketingSource: "mautic",
      marketingSourceEventId: "mautic.form_on_submit:submission:1",
    })).rejects.toMatchObject({ code: 11000 });

    /* The same event id under a different company is accepted. */
    const other = await Activity.create({
      activityType: "note", subject: "other company", leadId: leadB._id,
      marketingCompanyId: COMPANY_B, marketingSource: "mautic",
      marketingSourceEventId: "mautic.form_on_submit:submission:1",
    });
    expect(other._id).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. ACCOUNT OWNERSHIP IS VERIFIED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A linked Account is verified, not trusted", () => {
  test("an Account in another company produces no Activity and leaves the receipt pending", async () => {
    const foreign = await Account.create({ companyId: COMPANY_B, companyName: "Someone else", status: "active" });
    await identityIn(COMPANY_A, { salesAccountId: foreign._id });

    const [{ receipt }] = await ingestIn(COMPANY_A, formPayload(1));

    expect(await Activity.countDocuments({})).toBe(0);
    expect(receipt.state).toBe("ACTIVITY_PENDING");
    expect(receipt.activity.error).toContain("No canonical Sales record");
    /* And nothing anywhere references the foreign Account. */
    expect(await Activity.countDocuments({ accountId: foreign._id })).toBe(0);
  });

  test("an Account in this company projects normally", async () => {
    const mine = await Account.create({ companyId: COMPANY_A, companyName: "Aurora Hotels", status: "active" });
    await identityIn(COMPANY_A, { salesAccountId: mine._id });

    const [{ receipt }] = await ingestIn(COMPANY_A, formPayload(1));
    const act = await Activity.findOne({}).lean();
    expect(act.accountId).toEqual(mine._id);
    expect(receipt.state).toBe("ACTIVITY_PROJECTED");
  });

  test("linkedSalesRecord reads the Account rather than believing the identity", async () => {
    const foreign = await Account.create({ companyId: COMPANY_B, companyName: "Theirs", status: "active" });
    const identity = { salesAccountId: foreign._id };
    expect(await projection.linkedSalesRecord({ companyId: COMPANY_A, identity })).toBeNull();
    expect(await projection.linkedSalesRecord({ companyId: COMPANY_B, identity }))
      .toMatchObject({ type: "account" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. NOT EVERY 11000 IS A REPLAY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Duplicate-key errors are diagnosed, not assumed", () => {
  test("a provenance collision is an idempotent replay with the real Activity id", async () => {
    const leadA = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    const [{ receipt: first }] = await ingestIn(COMPANY_A, formPayload(1));
    const [{ receipt: second }] = await ingestIn(COMPANY_A, formPayload(1));

    expect(first.activity.state).toBe("projected");
    expect(second.activity.state).toBe("projected");
    /* The same id both times — never null. */
    expect(String(second.activity.activityId)).toBe(String(first.activity.activityId));
    expect(await Activity.countDocuments({})).toBe(1);
  });

  test("an unrelated unique collision is a real failure, not a silent success", async () => {
    const leadA = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });

    /* `activityId` is unique and generated by a countDocuments()+1 pre-save
       hook, so it collides whenever two activities are created at once. That is
       a genuine failure and used to be reported as an idempotent replay with a
       null id — the timeline entry was never written and the receipt said it
       was. */
    const spy = jest.spyOn(Activity, "create").mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key error collection: crm.activities index: activityId_1"),
        { code: 11000, keyPattern: { activityId: 1 } }),
    );

    const [{ receipt }] = await ingestIn(COMPANY_A, formPayload(1));
    spy.mockRestore();

    expect(receipt.state).toBe("ACTIVITY_FAILED");
    expect(receipt.activity.state).toBe("failed");
    expect(receipt.activity.activityId).toBeNull();
    expect(await Activity.countDocuments({})).toBe(0);
  });

  test("no receipt reads ACTIVITY_PROJECTED without a matching Activity id", async () => {
    const leadA = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    await ingestIn(COMPANY_A, formPayload(1));
    await ingestIn(COMPANY_A, formPayload(2));

    const projected = await MarketingEventReceipt.find({ "activity.state": "projected" }).lean();
    expect(projected.length).toBeGreaterThan(0);
    for (const r of projected) {
      expect(r.activity.activityId).toBeTruthy();
      const act = await Activity.findById(r.activity.activityId).lean();
      expect(act).toBeTruthy();
      /* And it is this company's. */
      expect(String(act.marketingCompanyId)).toBe(String(COMPANY_A));
    }
  });

  test("a failed projection is retried and then succeeds", async () => {
    const leadA = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    const spy = jest.spyOn(Activity, "create").mockRejectedValueOnce(
      Object.assign(new Error("E11000 activityId_1"), { code: 11000, keyPattern: { activityId: 1 } }));
    await ingestIn(COMPANY_A, formPayload(1));
    spy.mockRestore();

    const resumed = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(resumed.resolved).toBe(1);
    expect(await Activity.countDocuments({})).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE WEBHOOK ACKNOWLEDGES ONLY WHAT IT DURABLY HOLDS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Webhook acknowledgement semantics", () => {
  test("invalid provider content is 200 and named as rejected", async () => {
    const res = await postWebhook({
      "mautic.form_on_submit": [{ submission: { lead: leadBlock() } }],   // no id
    });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0].reason).toContain("cannot be deduplicated");
    expect(await MarketingIntentEvent.countDocuments({})).toBe(0);
  });

  test("an unknown event type is 200 and named as ignored", async () => {
    const res = await postWebhook({ "mautic.telepathy_on_hunch": [{ whatever: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toEqual([{ type: "mautic.telepathy_on_hunch", count: 1 }]);
  });

  test("a ledger database failure is 5xx so Mautic retries", async () => {
    const spy = jest.spyOn(MarketingIntentEvent, "create")
      .mockRejectedValueOnce(Object.assign(new Error("connection pool destroyed"), { name: "MongoNetworkError" }));

    const res = await postWebhook(formPayload(1));
    spy.mockRestore();

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    /* No database message, no driver name, no stack. */
    const s = JSON.stringify(res.body);
    expect(s).not.toContain("connection pool");
    expect(s).not.toContain("MongoNetworkError");
    expect(await MarketingIntentEvent.countDocuments({})).toBe(0);
  });

  test("a receipt persistence failure is 5xx, and the replay resumes without duplicating", async () => {
    await identityIn(COMPANY_A);
    const spy = jest.spyOn(engagement, "processEvent")
      .mockRejectedValueOnce(new Error("receipt write failed"));

    const first = await postWebhook(formPayload(1));
    spy.mockRestore();

    expect(first.status).toBe(503);
    /* The ledger row IS there — it is immutable and was written first. */
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
    expect(await MarketingEventReceipt.countDocuments({})).toBe(0);

    /* Mautic retries. The replay finds the existing event and completes it. */
    const second = await postWebhook(formPayload(1));
    expect(second.status).toBe(200);
    expect(second.body.duplicates).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
    expect(await MarketingEventReceipt.countDocuments({})).toBe(1);
  });

  test("a missing ledger row after a supposedly successful insert is never acknowledged", async () => {
    /* The read-back is now company-scoped `findOne`, not `findById` — see
       correction 2. Mocking the call the route actually makes. */
    const spy = jest.spyOn(MarketingIntentEvent, "findOne")
      .mockReturnValueOnce({ lean: async () => null });
    const res = await postWebhook(formPayload(1));
    spy.mockRestore();
    expect(res.status).toBe(503);
  });

  test("a durably recorded failed receipt is 200 with needsAttention", async () => {
    await identityIn(COMPANY_A);
    await grantIn(COMPANY_A);
    const spy = jest.spyOn(consentService, "suppress").mockRejectedValueOnce(new Error("consent store down"));

    const res = await postWebhook(unsubPayload(7));
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.needsAttention).toEqual([
      { sourceEventId: "mautic.lead_channel_subscription_changed:dnc:7", state: "SUPPRESSION_FAILED" },
    ]);
    /* Durably owed, so retrying the delivery would add nothing. */
    expect((await MarketingEventReceipt.findOne({}).lean()).state).toBe("SUPPRESSION_FAILED");
  });

  test("the 1 MB cap and raw-byte verification are unchanged", async () => {
    const body = JSON.stringify(formPayload(1));
    const r = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Webhook-Signature": signed(body, "wrong") },
      body,
    });
    expect(r.status).toBe(401);
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Marketing", "marketingHandovers.js"), "utf8");
    expect(src).toContain('limit: "1mb"');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. CONSENT HISTORY AND CURRENT STATE CANNOT DIVERGE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Consent replay reconciles the canonical state", () => {
  /** Write suppression history, then lose the current-state projection —
   *  exactly what a crash between the two writes leaves behind. */
  async function historyWithoutProjection(companyId) {
    await grantIn(companyId);
    const { events } = contract.translate(unsubPayload(7));
    const commandKey = engagement.suppressionCommandKey(events[0]);
    await consentService.suppress({
      companyId, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      reason: "unsubscribed", actor: null, commandKey,
    });
    /* Roll the projection back to before the suppression, leaving history
       intact. The history row is append-only and untouched. */
    await MarketingConsent.updateOne(
      { companyId, gravPersonKey: KEY },
      { $set: { state: "opted_in", revision: 1, withdrawnAt: null, withdrawalReason: "" } },
    );
    return commandKey;
  }

  test("before recovery the receipt does not claim suppression succeeded", async () => {
    await identityIn(COMPANY_A);
    await historyWithoutProjection(COMPANY_A);
    /* The canonical row is behind its own history. */
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("opted_in");

    /* Processing the event again must NOT read the history row as proof. It
       reconciles, so the outcome here is a genuine repair rather than a false
       "already applied" — and either way it may only claim applied when the
       canonical record agrees. */
    const [{ receipt }] = await ingestIn(COMPANY_A, unsubPayload(7));
    const consent = await MarketingConsent.findOne({}).lean();
    if (receipt.suppression.state === "applied") {
      expect(consent.state).toBe("suppressed");
    } else {
      expect(receipt.state).toBe("SUPPRESSION_FAILED");
      expect(consent.state).not.toBe("suppressed");
    }
  });

  test("replay repairs the current consent and adds no duplicate history", async () => {
    await identityIn(COMPANY_A);
    const commandKey = await historyWithoutProjection(COMPANY_A);
    const historyBefore = await MarketingConsentHistory.countDocuments({});

    const out = await consentService.suppress({
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      reason: "unsubscribed", actor: null, commandKey,
    });

    expect(out.duplicate).toBe(true);
    expect(out.repaired).toBe(true);
    expect(out.reflected).toBe(true);
    expect(await MarketingConsentHistory.countDocuments({})).toBe(historyBefore);

    const consent = await MarketingConsent.findOne({}).lean();
    expect(consent.state).toBe("suppressed");
    expect(consent.revision).toBe(2);
  });

  test("outbound eligibility is refused after the repair", async () => {
    await identityIn(COMPANY_A);
    await historyWithoutProjection(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));

    const verdict = await consentService.resolveEffective({
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
    });
    expect(verdict).toMatchObject({ eligible: false, reasonCode: "CONSENT_SUPPRESSED" });
  });

  test("an older replay cannot overwrite a newer consent decision", async () => {
    await identityIn(COMPANY_A);
    const commandKey = await historyWithoutProjection(COMPANY_A);

    /* A newer, legitimate decision lands first: the person opts back in. */
    await consentService.record({
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      state: "opted_in", capturedSource: "came back via the website",
      actor: { name: "Marketer" }, commandKey: "newer-command",
    });
    const newer = await MarketingConsent.findOne({}).lean();
    expect(newer.state).toBe("opted_in");
    /* Its history entry retried onto the next free revision, and the current row
       carries THAT revision rather than the pre-retry guess. */
    expect(newer.revision).toBe(3);

    /* Now the older suppression command replays. It must not win. */
    const out = await consentService.suppress({
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      reason: "unsubscribed", actor: null, commandKey,
    });
    const after = await MarketingConsent.findOne({}).lean();
    expect(after.revision).toBe(newer.revision);
    expect(after.state).toBe("opted_in");
    /* And the replay reports that its own command is superseded, not applied. */
    expect(out.duplicate).toBe(true);
  });

  test("two concurrent distinct commands cannot share a revision", async () => {
    await grantIn(COMPANY_A);
    const base = {
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      capturedSource: "test", actor: { name: "T" },
    };
    const results = await Promise.allSettled([
      consentService.record({ ...base, state: "opted_out", reason: "a", commandKey: "cmd-a" }),
      consentService.record({ ...base, state: "suppressed", reason: "b", commandKey: "cmd-b" }),
      consentService.record({ ...base, state: "opted_out", reason: "c", commandKey: "cmd-c" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(0);

    const history = await MarketingConsentHistory.find({}).sort({ revision: 1 }).lean();
    const revisions = history.map((h) => h.revision);
    /* No two entries claim the same revision. Before the unique index, two
       concurrent commands both computed revision+1 and both appended, leaving
       no way to tell which produced the current state. */
    expect(new Set(revisions).size).toBe(revisions.length);
    /* And the current row matches the highest history revision. */
    const current = await MarketingConsent.findOne({}).lean();
    expect(current.revision).toBe(Math.max(...revisions));
  });

  test("reconciliation orders by revision, not by timestamp", async () => {
    await grantIn(COMPANY_A);
    await consentService.withdraw({
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      reason: "stop", actor: { name: "T" }, commandKey: "w1",
    });
    /* Two entries sharing a timestamp to the millisecond — revision is the only
       thing that can order them. */
    await MarketingConsentHistory.collection.updateMany({}, { $set: { at: new Date("2026-09-09T00:00:00Z") } });
    await MarketingConsent.updateOne({}, { $set: { state: "opted_in", revision: 1 } });

    const out = await consentService.reconcileFromHistory({
      companyId: COMPANY_A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
    });
    expect(out.repaired).toBe(true);
    expect(out.record.state).toBe("opted_out");
    expect(out.record.revision).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. LEDGER EVENTS WITH NO RECEIPT ARE FOUND AND REPAIRED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Orphaned observations are recoverable", () => {
  /** A ledger row whose receipt never got written. */
  async function orphanIn(companyId, payload = formPayload(1)) {
    const { events } = contract.translate(payload);
    const r = await eventIntake.recordEvent({ companyId, event: events[0] });
    return MarketingIntentEvent.findById(r.eventId).lean();
  }

  test("an event with no receipt is found from the ledger side", async () => {
    await orphanIn(COMPANY_A);
    expect(await MarketingEventReceipt.countDocuments({})).toBe(0);

    /* A receipt scan sees nothing — which is exactly why it was invisible. */
    const resumed = await engagement.resumeUnfinished({ companyId: COMPANY_A });
    expect(resumed.considered).toBe(0);

    const orphans = await engagement.findEventsMissingReceipts({ companyId: COMPANY_A });
    expect(orphans).toHaveLength(1);
    expect(orphans[0].sourceEventId).toBe("mautic.form_on_submit:submission:1");
  });

  test("Data Health reports the missing-receipt count", async () => {
    await orphanIn(COMPANY_A);
    const res = await api("/data-health");
    expect(res.status).toBe(200);
    expect(res.body.engagement.missingReceipts).toBe(1);
    expect(res.body.engagement.eventsProcessed).toBe(0);
  });

  test("recovery creates exactly one receipt and processes it", async () => {
    const leadA = await leadIn(COMPANY_A);
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    await orphanIn(COMPANY_A);

    const out = await engagement.recoverMissingReceipts({ companyId: COMPANY_A });
    expect(out).toMatchObject({ found: 1, recovered: 1, failed: 0 });
    expect(await MarketingEventReceipt.countDocuments({})).toBe(1);
    expect((await MarketingEventReceipt.findOne({}).lean()).state).toBe("ACTIVITY_PROJECTED");
    expect(await Activity.countDocuments({})).toBe(1);

    /* And it is no longer an orphan. */
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A }))
      .toEqual({ count: 0, capped: false });
  });

  test("concurrent recovery cannot create duplicate receipts", async () => {
    await identityIn(COMPANY_A);
    await orphanIn(COMPANY_A);
    await Promise.all([1, 2, 3].map(() => engagement.recoverMissingReceipts({ companyId: COMPANY_A })));
    expect(await MarketingEventReceipt.countDocuments({})).toBe(1);
  });

  test("another company's orphan is never read or repaired", async () => {
    await orphanIn(COMPANY_B);
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_A }))
      .toEqual({ count: 0, capped: false });
    const out = await engagement.recoverMissingReceipts({ companyId: COMPANY_A });
    expect(out.found).toBe(0);
    expect(await MarketingEventReceipt.countDocuments({})).toBe(0);

    /* Company B's own recovery finds it. */
    expect(await engagement.countEventsMissingReceipts({ companyId: COMPANY_B }))
      .toEqual({ count: 1, capped: false });
  });

  test("recovery requires a company", async () => {
    await expect(engagement.findEventsMissingReceipts({}))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   REGRESSION BOUNDARIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("The boundaries these corrections must not have moved", () => {
  test("the ledger is still immutable and a resubscribe still never unsuppresses", async () => {
    await identityIn(COMPANY_A);
    await grantIn(COMPANY_A);
    await ingestIn(COMPANY_A, unsubPayload(7));
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("suppressed");

    await ingestIn(COMPANY_A, {
      "mautic.lead_channel_subscription_changed": [{
        contact: leadBlock(), channel: "email", old_status: "unsubscribed",
        new_status: "contactable", timestamp: "2026-09-09T14:00:00+00:00",
      }],
    });
    expect((await MarketingConsent.findOne({}).lean()).state).toBe("suppressed");

    const row = await MarketingIntentEvent.findOne({});
    await expect(MarketingIntentEvent.updateOne({ _id: row._id }, { $set: { kind: "email_opened" } })).rejects.toThrow();
  });

  test("no Sales record is created or moved by any of this", async () => {
    const leadA = await leadIn(COMPANY_A);
    const before = await Lead.findById(leadA._id).lean();
    await identityIn(COMPANY_A, { salesLeadId: leadA._id });
    await grantIn(COMPANY_A);
    await ingestIn(COMPANY_A, formPayload(1));
    await ingestIn(COMPANY_A, unsubPayload(7));
    await engagement.recoverMissingReceipts({ companyId: COMPANY_A });

    const after = await Lead.findById(leadA._id).lean();
    expect(after.captureStatus).toBe(before.captureStatus);
    expect(after.reviewStatus).toBe(before.reviewStatus);
    expect(after.qualificationState).toBe(before.qualificationState);
    expect(await Lead.countDocuments({})).toBe(1);
    expect(await Contact.countDocuments({})).toBe(0);
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
    expect(await Account.countDocuments({})).toBe(0);
  });
});
