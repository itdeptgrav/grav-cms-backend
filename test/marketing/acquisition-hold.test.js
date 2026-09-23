// test/marketing/acquisition-hold.test.js
//
// THE PER-PERSON ACQUISITION PAUSE, PROVED BY THE LIES IT REFUSES TO TELL.
//
// The behaviour this replaces wrote `acquisitionPausedAt = now` in the same save
// as the Sales decision, with nothing in Mautic changed. So most of these tests
// are shaped the same way: make Mautic say no, then assert that GRAV says
// "requested" or "failed" and NOT "stopped".
//
// The Mautic double is a hand-written object rather than a jest mock of the
// client, deliberately: these tests need to assert exactly which endpoints were
// called and with what, that no campaign-wide or consent endpoint was called at
// all, and that memberships outside the registered acquisition scope survive. A
// recorded call list is the evidence for that, and an auto-mock would not give
// it. It also keeps real state, so a removal removes something and a read-back
// is a genuine read rather than a canned answer.
"use strict";

const mongoose = require("mongoose");

const acquisitionHold = require("../../services/marketing/acquisitionHold.service");
const salesOutcomeIntake = require("../../services/marketing/salesOutcomeIntake.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingAuditEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingConsent, MarketingConsentHistory } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const {
  SalesMarketingOutcomeOutboxEvent,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const outcomeDelivery = require("../../services/integration/marketingOutcomeDelivery.service");
const {
  SALES_OUTCOME_EVENT_KINDS, ACQUISITION_HOLD_FIELD, DELIVERY_RETRY,
} = require("../../constants/marketing");

const KEY = "grav-person-hold-1";
const EMAIL = "ops@aurorahotels.in";
const CONTACT = "501";

/* ── THE REGISTERED ACQUISITION SCOPE ───────────────────────────────────────
   Segment 9 and campaign 4 are acquisition. Segment 11 is a post-sale service
   path, 12 a transactional one, 13 the Sales-assisted nurture path Sales itself
   asked for, and campaigns 5, 6 and 7 run on those. An acceptance must touch
   none of them. */
const ACQ_SEGMENT = 9;
const ACQ_CAMPAIGN = 4;
const SERVICE_SEGMENT = 11;
const TRANSACTIONAL_SEGMENT = 12;
const NURTURE_SEGMENT = 13;
const SERVICE_CAMPAIGN = 5;
const TRANSACTIONAL_CAMPAIGN = 6;
const NURTURE_CAMPAIGN = 7;

const SCOPE_ENV = Object.freeze({
  MAUTIC_ACQUISITION_SEGMENTS: "grav-acquisition",
  MAUTIC_ACQUISITION_CAMPAIGNS: String(ACQ_CAMPAIGN),
});

let A;
let B;
const savedEnv = {};

function mauticDouble({
  /* What the CONTACT belongs to: one acquisition path plus three an acceptance
     must never disturb. */
  contactSegments = [
    { id: ACQ_SEGMENT, alias: "grav-acquisition" },
    { id: SERVICE_SEGMENT, alias: "post-sale-service" },
    { id: TRANSACTIONAL_SEGMENT, alias: "order-transactional" },
    { id: NURTURE_SEGMENT, alias: "sales-assisted-nurture" },
  ],
  contactCampaigns = [
    { id: ACQ_CAMPAIGN, alias: "grav-acquisition-journey" },
    { id: SERVICE_CAMPAIGN, alias: "service-reminders" },
    { id: TRANSACTIONAL_CAMPAIGN, alias: "order-updates" },
    { id: NURTURE_CAMPAIGN, alias: "sales-assisted-nurture" },
  ],
  /* What the INSTANCE holds, which is what the declared scope resolves against. */
  instanceSegments = [
    { id: ACQ_SEGMENT, alias: "grav-acquisition", name: "GRAV acquisition", filters: [] },
    { id: SERVICE_SEGMENT, alias: "post-sale-service", name: "Service", filters: [] },
    { id: TRANSACTIONAL_SEGMENT, alias: "order-transactional", name: "Transactional", filters: [] },
    { id: NURTURE_SEGMENT, alias: "sales-assisted-nurture", name: "Nurture", filters: [] },
  ],
  instanceCampaigns = [
    { id: ACQ_CAMPAIGN, alias: "grav-acquisition-journey", name: "Acquisition", lists: [{ id: ACQ_SEGMENT }] },
    { id: SERVICE_CAMPAIGN, alias: "service-reminders", name: "Service", lists: [{ id: SERVICE_SEGMENT }] },
    { id: TRANSACTIONAL_CAMPAIGN, alias: "order-updates", name: "Transactional", lists: [{ id: TRANSACTIONAL_SEGMENT }] },
    { id: NURTURE_CAMPAIGN, alias: "sales-assisted-nurture", name: "Nurture", lists: [{ id: NURTURE_SEGMENT }] },
  ],
  failOn = null,
  failWith = { code: "MAUTIC_UNAVAILABLE", message: "Mautic did not respond." },
  /* A Mautic that accepts every removal and still reports the membership — the
     exact behaviour the read-back exists to catch. */
  ignoreRemovals = false,
  /* A Mautic that accepts the field write and stores nothing. */
  holdFieldSticks = true,
} = {}) {
  const state = {
    segments: [...contactSegments],
    campaigns: [...contactCampaigns],
    instanceSegments: instanceSegments.map((x) => ({ ...x, filters: [...(x.filters || [])] })),
    instanceCampaigns: instanceCampaigns.map((x) => ({ ...x })),
    fields: {},
  };
  const calls = [];
  const maybeFail = (name) => {
    if (failOn === name) {
      const err = new Error(failWith.message);
      err.code = failWith.code;
      throw err;
    }
  };
  const find = (list, id) => list.find((x) => String(x.id) === String(id));

  return {
    state,
    calls,
    async listSegments() {
      calls.push({ call: "listSegments" });
      maybeFail("listSegments");
      return state.instanceSegments;
    },
    /* The capability probe for campaigns. A Mautic identity without campaign
       permission gets 403 here — the only unambiguous signal available, because
       the per-contact campaign read answers 200 with an empty list instead. */
    async listCampaigns() {
      calls.push({ call: "listCampaigns" });
      maybeFail("listCampaigns");
      return state.instanceCampaigns;
    },
    async getSegment(id) {
      calls.push({ call: "getSegment", id: String(id) });
      maybeFail("getSegment");
      return find(state.instanceSegments, id) || null;
    },
    async updateSegment(id, fields) {
      calls.push({ call: "updateSegment", id: String(id), fields });
      maybeFail("updateSegment");
      const seg = find(state.instanceSegments, id);
      Object.assign(seg, fields);
      return seg;
    },
    async getCampaign(id) {
      calls.push({ call: "getCampaign", id: String(id) });
      maybeFail("getCampaign");
      return find(state.instanceCampaigns, id) || null;
    },
    async updateContact(id, fields) {
      calls.push({ call: "updateContact", id: String(id), fields });
      maybeFail("updateContact");
      if (holdFieldSticks) Object.assign(state.fields, fields);
      return { id };
    },
    async getContact(id) {
      calls.push({ call: "getContact", id: String(id) });
      maybeFail("getContact");
      return { id, fields: { all: { ...state.fields } } };
    },
    async contactSegments(id) {
      calls.push({ call: "contactSegments", id: String(id) });
      maybeFail("contactSegments");
      return state.segments;
    },
    async contactCampaigns(id) {
      calls.push({ call: "contactCampaigns", id: String(id) });
      maybeFail("contactCampaigns");
      return state.campaigns;
    },
    async removeContactFromSegment(segmentId, id) {
      calls.push({ call: "removeContactFromSegment", segmentId: String(segmentId), id: String(id) });
      maybeFail("removeContactFromSegment");
      if (!ignoreRemovals) state.segments = state.segments.filter((x) => String(x.id) !== String(segmentId));
      return { success: true };
    },
    async removeContactFromCampaign(campaignId, id) {
      calls.push({ call: "removeContactFromCampaign", campaignId: String(campaignId), id: String(id) });
      maybeFail("removeContactFromCampaign");
      if (!ignoreRemovals) state.campaigns = state.campaigns.filter((x) => String(x.id) !== String(campaignId));
      return { success: true };
    },
  };
}

beforeAll(() => {
  for (const k of Object.keys(SCOPE_ENV)) savedEnv[k] = process.env[k];
});
/* ── RESTORED AFTER EVERY TEST, NOT JUST AT THE END ────────────────────────
   Jest reuses a worker process across test FILES, so anything left in
   `process.env` here is still set when the next file runs. A stray acquisition
   scope made other suites resolve it for real, which meant live HTTP to the
   development Mautic, retries, timeouts and a cascade of unrelated failures. */
const restoreEnv = () => {
  for (const k of Object.keys(SCOPE_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};
afterEach(restoreEnv);
afterAll(restoreEnv);

beforeEach(async () => {
  A = new mongoose.Types.ObjectId();
  B = new mongoose.Types.ObjectId();
  /* The registered scope, as a deployment sets it. `receive` reaches `apply`
     without an env argument, which is exactly how production runs. */
  Object.assign(process.env, SCOPE_ENV);
  await Hold.syncIndexes();
  await MarketingConsentHistory.syncIndexes();
});

let refSeq = 0;
async function handoverIn(companyId, over = {}) {
  refSeq += 1;
  const ref = `MHO-2026-${String(9000 + refSeq)}`;
  return Handover.create({
    companyId,
    handoverRef: ref,
    state: "AWAITING_REVIEW",
    company: { name: "Aurora Hotels Pvt Ltd", domain: "aurorahotels.in" },
    person: { firstName: "Meera", workEmail: EMAIL },
    matchKeys: { normalizedEmail: EMAIL, externalContactId: CONTACT },
    assessment: { handoverReason: "Asked for a quotation.", recommendedAction: "call_within_one_business_day" },
    correlationId: `corr-${ref}`,
    submittedAt: new Date(),
    ...over,
  });
}

const identityIn = (companyId) => MarketingIdentity.create({
  companyId, gravPersonKey: KEY, email: EMAIL,
  externals: [{ system: "mautic", externalId: CONTACT, proven: true }],
});

const grantIn = (companyId) => consentService.record({
  companyId, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
  state: "opted_in", capturedSource: "test", actor: { name: "T" },
});

const decisionEvent = (companyId, handoverRef, decision = "ACCEPTED") => ({
  companyId,
  kind: SALES_OUTCOME_EVENT_KINDS.DECIDED,
  occurredAt: new Date("2026-09-10T09:00:00Z"),
  correlationId: `${handoverRef}:decision`,
  payload: {
    handoverRef, decision, reason: decision === "ACCEPTED" ? "" : "Same buyer.",
    salesRecordType: "lead", salesRecordId: new mongoose.Types.ObjectId(), salesRecordRef: "LEAD-2026-0001",
  },
});

const removalsIn = (client) => client.calls.filter((c) => c.call.startsWith("removeContactFrom"));

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE DECISION AND ITS COMMAND ARE INSEPARABLE IN EFFECT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("an accepted outcome can never be left without its hold", () => {
  test("acceptance names the company, person, Mautic identity and handover", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);

    const out = await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() },
    );
    expect(out.applied).toBe(true);

    const hold = await Hold.findOne({ companyId: A, handoverRef: h.handoverRef });
    expect(hold.reason).toBe("SALES_ACCEPTED");
    expect(hold.gravPersonKey).toBe(KEY);
    expect(hold.mauticContactId).toBe(CONTACT);
    expect(String(hold.handoverId)).toBe(String(h._id));
    expect(hold.state).toBe("APPLIED");
  });

  test("a failure BETWEEN the outcome save and hold creation is repaired by the next delivery", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);

    /* ── THE EXACT WINDOW ─────────────────────────────────────────────────
       `receive` saves the outcome, then calls `request`. Failing `request` once
       reproduces a crash, a refused write or a dropped connection in between.
       Before this correction the handover was permanently ACCEPTED with no
       command, and every later delivery returned "already accepted" without
       creating one — a self-sealing hole. */
    const spy = jest.spyOn(acquisitionHold, "request")
      .mockRejectedValueOnce(new Error("connection lost after the outcome was stored"));

    await expect(salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() },
    )).rejects.toThrow(/connection lost/);
    spy.mockRestore();

    /* The damage: a decided handover and no command. */
    const stranded = await Handover.findById(h._id).lean();
    expect(stranded.outcome.decision).toBe("ACCEPTED");
    expect(stranded.state).toBe("ACCEPTED");
    expect(await Hold.countDocuments({ companyId: A })).toBe(0);

    /* The repair, from an ordinary redelivery of the same decision. */
    const replay = await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() },
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.reconciled).toContain("acquisitionHold");

    const holds = await Hold.find({ companyId: A }).lean();
    expect(holds).toHaveLength(1);
    expect(holds[0].companyId).toEqual(A);
    expect(holds[0].handoverRef).toBe(h.handoverRef);
    expect(holds[0].gravPersonKey).toBe(KEY);
    expect(holds[0].mauticContactId).toBe(CONTACT);
    expect(holds[0].state).toBe("APPLIED");
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt)
      .toEqual(holds[0].confirmedAt);

    /* And the first answer was never rewritten. */
    const after = await Handover.findById(h._id).lean();
    expect(after.outcome.decidedAt).toEqual(stranded.outcome.decidedAt);
  });

  test("the outbox keeps redelivering until the hold exists, through the real delivery path", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);

    /* The production path: Sales' outbox row, walked by the delivery service.
       Nothing here passes a Mautic client, exactly as production does not. */
    await SalesMarketingOutcomeOutboxEvent.create({
      companyId: A,
      kind: SALES_OUTCOME_EVENT_KINDS.DECIDED,
      payload: {
        handoverRef: h.handoverRef, receiptId: new mongoose.Types.ObjectId(), decision: "ACCEPTED",
        salesRecordType: "lead", salesRecordId: new mongoose.Types.ObjectId(), salesRecordRef: "LEAD-2026-0002",
      },
      occurredAt: new Date(),
      correlationId: `${h.handoverRef}:decision`,
    });

    const spy = jest.spyOn(acquisitionHold, "request")
      .mockRejectedValueOnce(new Error("connection lost after the outcome was stored"));
    const first = await outcomeDelivery.deliverPending({ companyId: A });
    spy.mockRestore();

    expect(first).toMatchObject({ attempted: 1, failed: 1, delivered: 0 });
    /* The outcome is stored, the command is missing, and the announcement is
       still PENDING — which is what brings the repair about by itself. */
    expect((await Handover.findById(h._id)).outcome.decision).toBe("ACCEPTED");
    expect(await Hold.countDocuments({ companyId: A })).toBe(0);
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A, status: "PENDING" })).toBe(1);

    const second = await outcomeDelivery.deliverPending({ companyId: A });
    expect(second).toMatchObject({ attempted: 1, duplicates: 1, failed: 0 });
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A, status: "PENDING" })).toBe(0);

    /* No Mautic is reachable from this suite, so the command is owed and says
       so — it is emphatically not reported as a pause. */
    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.confirmedAt).toBeNull();
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt).toBeNull();
  });

  test("a lost audit line is repaired the same way, and never duplicated", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });

    /* The audit row lost to the same window. */
    await MarketingAuditEvent.deleteMany({
      companyId: A, handoverRef: h.handoverRef, action: "handover.accepted",
    });

    const replay = await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() },
    );
    expect(replay.reconciled).toContain("audit");

    for (let i = 0; i < 2; i += 1) {
      await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });
    }
    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, handoverRef: h.handoverRef, action: "handover.accepted",
    })).toBe(1);
  });

  test("concurrent replays create exactly one hold", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });
    await Hold.deleteMany({ companyId: A });

    /* Six deliveries at once. The unique index on (companyId, handoverRef) is
       what makes this safe, not a read-then-write check both could pass. */
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() },
    )));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
  });

  test("a command correctly waiting on its backoff is left alone by a replay", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef),
      { mauticClient: mauticDouble({ failOn: "contactSegments" }) },
    );
    const failed = await Hold.findOne({ companyId: A }).lean();
    expect(failed.state).toBe("FAILED");
    expect(failed.nextAttemptAt).toBeInstanceOf(Date);

    const client = mauticDouble();
    const replay = await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: client },
    );
    expect(replay.acquisitionHold.note).toMatch(/Awaiting its scheduled retry/);
    /* Not re-attempted early: the backoff exists to be honoured. */
    expect(client.calls).toEqual([]);
    expect((await Hold.findOne({ companyId: A })).attempts).toBe(failed.attempts);
  });

  test("a duplicate link raises one too, and a RETURNED decision raises none", async () => {
    const dup = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await salesOutcomeIntake.receive(
      decisionEvent(A, dup.handoverRef, "DUPLICATE_LINKED"), { mauticClient: mauticDouble() },
    );
    expect((await Hold.findOne({ companyId: A, handoverRef: dup.handoverRef })).reason)
      .toBe("SALES_DUPLICATE_LINKED");

    const ret = await handoverIn(A);
    const client = mauticDouble();
    await salesOutcomeIntake.receive({
      ...decisionEvent(A, ret.handoverRef, "RETURNED"),
      payload: {
        handoverRef: ret.handoverRef, decision: "RETURNED", reason: "Too early.",
        nurtureTopic: "fabric durability", revisitAt: "2027-03-01T00:00:00.000Z",
      },
    }, { mauticClient: client });

    expect(await Hold.countDocuments({ companyId: A, handoverRef: ret.handoverRef })).toBe(0);
    /* Nothing asked of Mautic in either direction: a return must not resume
       acquisition any more than it pauses it. */
    expect(client.calls).toEqual([]);
    const handover = await Handover.findOne({ handoverRef: ret.handoverRef }).lean();
    expect(handover.outcome.nurtureTopic).toBe("fabric durability");
    expect(handover.outcome.revisitAt).toBeInstanceOf(Date);
  });

  test("three replays remain idempotent end to end", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble();
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });
    const first = await Hold.findOne({ companyId: A }).lean();
    const auditBefore = await MarketingAuditEvent.countDocuments({ companyId: A, handoverRef: h.handoverRef });

    for (let i = 0; i < 3; i += 1) {
      const again = await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });
      expect(again.duplicate).toBe(true);
      expect(again.reconciled).toEqual([]);
    }

    const after = await Hold.findOne({ companyId: A }).lean();
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
    expect(after.attempts).toBe(first.attempts);
    expect(after.confirmedAt).toEqual(first.confirmedAt);
    expect(await MarketingAuditEvent.countDocuments({ companyId: A, handoverRef: h.handoverRef }))
      .toBe(auditBefore);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. ACQUISITION IS DECLARED, NOT INFERRED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("only registered acquisition automation is touched", () => {
  test("with no registered scope, nothing is removed and nothing is confirmed", async () => {
    delete process.env.MAUTIC_ACQUISITION_SEGMENTS;
    delete process.env.MAUTIC_ACQUISITION_CAMPAIGNS;

    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble();

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.state).toBe("FAILED");
    expect(hold.confirmedAt).toBeNull();
    expect(hold.activeError.reasonCode).toBe("ACQUISITION_SCOPE_MISSING");
    expect(hold.activeError.failureClass).toBe("TERMINAL");
    expect(hold.activeError.message).toMatch(/MAUTIC_ACQUISITION_SEGMENTS/);
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt).toBeNull();

    /* Nothing removed, and the contact not even flagged. */
    expect(removalsIn(client)).toEqual([]);
    expect(client.calls.some((c) => c.call === "updateContact")).toBe(false);
    expect(client.state.segments).toHaveLength(4);
    expect(client.state.campaigns).toHaveLength(4);
  });

  test("a registered name that does not exist in Mautic is a visible refusal", async () => {
    process.env.MAUTIC_ACQUISITION_SEGMENTS = "segment-that-was-deleted";
    const h = await handoverIn(A);
    await identityIn(A);
    const client = mauticDouble();

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.activeError.reasonCode).toBe("ACQUISITION_SCOPE_UNVERIFIABLE");
    expect(hold.activeError.message).toMatch(/segment-that-was-deleted/);
    expect(removalsIn(client)).toEqual([]);
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt).toBeNull();
  });

  test("a Mautic that cannot be read for scope is a visible refusal, not an empty one", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    /* ── THE DEFECT THIS PINS ────────────────────────────────────────────
       Found against the live 7.2.0 instance with GRAV's own least-privilege
       integration user: `GET /api/contacts/{id}/campaigns` answers 200 AND AN
       EMPTY LIST when the identity lacks campaign permission, while the removal
       still succeeds. So the service saw no campaigns, removed none, read back
       none remaining, and wrote a CONFIRMED stop for a person still in a running
       campaign. The collection reads DO answer 403, and resolving the scope
       through them converts that blindness into an honest failure. */
    const blind = mauticDouble({
      failOn: "listCampaigns",
      failWith: { code: "MAUTIC_AUTH_FAILED", message: "Mautic refused GRAV's credentials." },
    });

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: blind });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.state).toBe("FAILED");
    expect(hold.confirmedAt).toBeNull();
    expect(hold.activeError.reasonCode).toBe("ACQUISITION_SCOPE_UNVERIFIABLE");
    expect(hold.activeError.message).toMatch(/segment and campaign view and edit permission/);
    expect(removalsIn(blind)).toEqual([]);
  });

  test("one contact in acquisition, service, transactional and nurture loses only acquisition", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble();

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.state).toBe("APPLIED");
    expect(hold.evidence.segmentsRemoved).toEqual([String(ACQ_SEGMENT)]);
    expect(hold.evidence.campaignsRemoved).toEqual([String(ACQ_CAMPAIGN)]);
    expect(hold.evidence.segmentsLeftAlone).toBe(3);
    expect(hold.evidence.campaignsLeftAlone).toBe(3);

    /* The three other paths survive, in Mautic's own state. */
    expect(client.state.segments.map((x) => String(x.id)).sort())
      .toEqual([SERVICE_SEGMENT, TRANSACTIONAL_SEGMENT, NURTURE_SEGMENT].map(String).sort());
    expect(client.state.campaigns.map((x) => String(x.id)).sort())
      .toEqual([SERVICE_CAMPAIGN, TRANSACTIONAL_CAMPAIGN, NURTURE_CAMPAIGN].map(String).sort());

    /* And every removal named exactly one acquisition id and one contact. */
    for (const r of removalsIn(client)) {
      expect(r.id).toBe(CONTACT);
      expect([String(ACQ_SEGMENT), String(ACQ_CAMPAIGN)]).toContain(r.segmentId || r.campaignId);
    }
  });

  test("the scope actually used is stored, so a later config change cannot rewrite history", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.evidence.scope.segments.map((x) => x.id)).toEqual([String(ACQ_SEGMENT)]);
    expect(hold.evidence.scope.campaigns.map((x) => x.id)).toEqual([String(ACQ_CAMPAIGN)]);
    expect(hold.evidence.scope.declaredSegments).toEqual(["grav-acquisition"]);
    expect(hold.evidence.scope.resolvedAt).toBeInstanceOf(Date);

    /* Registration changes. The stored evidence does not. */
    process.env.MAUTIC_ACQUISITION_SEGMENTS = "post-sale-service";
    const again = await Hold.findOne({ companyId: A }).lean();
    expect(again.evidence.scope.segments.map((x) => x.id)).toEqual([String(ACQ_SEGMENT)]);
  });

  test("nothing campaign-wide and nothing consent-shaped is ever called", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble();
    for (const name of ["addDoNotContact", "updateCampaign", "unpublishCampaign", "deleteSegment"]) {
      client[name] = () => { throw new Error(`${name} must never be called`); };
    }

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });
    const made = client.calls.map((c) => c.call);
    expect(made).not.toContain("addDoNotContact");
    expect(made).not.toContain("updateCampaign");
    expect(made).not.toContain("deleteSegment");
  });

  test("canonical consent and its history are untouched", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const before = await MarketingConsent.findOne({ companyId: A, gravPersonKey: KEY }).lean();
    const historyBefore = await MarketingConsentHistory.countDocuments({ companyId: A, gravPersonKey: KEY });

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });

    const after = await MarketingConsent.findOne({ companyId: A, gravPersonKey: KEY }).lean();
    expect(after.state).toBe("opted_in");
    expect(after.revision).toBe(before.revision);
    expect(await MarketingConsentHistory.countDocuments({ companyId: A, gravPersonKey: KEY }))
      .toBe(historyBefore);
    const verdict = await consentService.resolveEffective({
      companyId: A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
    });
    expect(verdict.eligible).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. FUTURE ENROLMENT IS ACTUALLY PREVENTED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the hold prevents re-entry, not just today's membership", () => {
  test("every registered acquisition segment is given the exclusion filter and read back", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble();

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    const seg = client.state.instanceSegments.find((x) => String(x.id) === String(ACQ_SEGMENT));
    expect(seg.filters).toEqual([{
      glue: "and", field: ACQUISITION_HOLD_FIELD, object: "lead", type: "boolean",
      operator: "!=", properties: { filter: 1 },
    }]);
    /* Verified by reading the segment back, not assumed from the write. */
    const reads = client.calls.filter((c) => c.call === "getSegment" && c.id === String(ACQ_SEGMENT));
    expect(reads.length).toBeGreaterThanOrEqual(2);

    /* A non-acquisition segment's definition is never edited. */
    expect(client.state.instanceSegments.find((x) => String(x.id) === String(SERVICE_SEGMENT)).filters)
      .toEqual([]);

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.evidence.exclusionsGuarded).toEqual([String(ACQ_SEGMENT)]);
    expect(hold.evidence.exclusionsAdded).toEqual([String(ACQ_SEGMENT)]);
  });

  test("a segment that already carries the exclusion is not rewritten", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble({
      instanceSegments: [{
        id: ACQ_SEGMENT, alias: "grav-acquisition", name: "GRAV acquisition",
        filters: [acquisitionHold.HOLD_EXCLUSION_FILTER],
      }],
    });

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    expect(client.calls.some((c) => c.call === "updateSegment")).toBe(false);
    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.evidence.exclusionsGuarded).toEqual([String(ACQ_SEGMENT)]);
    expect(hold.evidence.exclusionsAdded).toEqual([]);
  });

  test("an acquisition campaign fed by an unregistered segment is refused", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    const client = mauticDouble({
      /* The acquisition campaign also draws from a segment nobody registered,
         so a held person would keep being pulled back in. */
      instanceCampaigns: [{
        id: ACQ_CAMPAIGN, alias: "grav-acquisition-journey", name: "Acquisition",
        lists: [{ id: ACQ_SEGMENT }, { id: 99 }],
      }],
    });

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.state).toBe("FAILED");
    expect(hold.activeError.reasonCode).toBe("ACQUISITION_SCOPE_UNVERIFIABLE");
    expect(hold.activeError.message).toMatch(/not registered acquisition segments/);
    expect(removalsIn(client)).toEqual([]);
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt).toBeNull();
  });

  test("the contact flag is believed only after a read-back", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    /* Mautic answers 200 to the PATCH and stores nothing. Before this
       correction `evidence.holdFieldSet` was hard-coded true from that 200. */
    const client = mauticDouble({ holdFieldSticks: false });

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.state).toBe("FAILED");
    expect(hold.confirmedAt).toBeNull();
    expect(hold.evidence.holdFieldSet).toBe(false);
    expect(hold.activeError.message).toMatch(/not marked as held/);
    /* It refused BEFORE removing anything, so the person is not left
       removed-but-re-enrollable. */
    expect(removalsIn(client)).toEqual([]);
  });

  test("the four facts a reader needs are reported separately", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });

    const state = await acquisitionHold.stateFor({ companyId: A, handoverRef: h.handoverRef });
    expect(state.disclosure).toMatchObject({
      currentlyRemoved: { segments: [String(ACQ_SEGMENT)], campaigns: [String(ACQ_CAMPAIGN)] },
      futureEnrollmentPrevented: true,
      awaitingRetry: false,
      retryIsAutomatic: false,
      confirmedStopped: true,
    });
    expect(state.disclosure.guardedAcquisitionSegments).toEqual([String(ACQ_SEGMENT)]);
  });

  test("a failed hold prevents nothing and says so", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble({ failOn: "contactCampaigns" }) },
    );
    const state = await acquisitionHold.stateFor({ companyId: A, handoverRef: h.handoverRef });
    expect(state.disclosure).toMatchObject({
      futureEnrollmentPrevented: false,
      awaitingRetry: true,
      retryIsAutomatic: false,
      confirmedStopped: false,
      confirmedAt: null,
    });
    expect(state.disclosure.currentlyRemoved).toEqual({ segments: [], campaigns: [] });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. HONEST RECOVERY WORDING, AND A REAL REPAIR PATH
   ═══════════════════════════════════════════════════════════════════════════ */

describe("nothing promises automatic recovery", () => {
  test("no Sales-facing label claims an automatic retry", () => {
    for (const label of Object.values(acquisitionHold.SALES_FACING_LABEL)) {
      expect(label).not.toMatch(/automatically/i);
      expect(label).not.toMatch(/will be retried/i);
    }
    expect(acquisitionHold.SALES_FACING_LABEL.RETRY_WAITING).toMatch(/awaiting retry/i);
    expect(acquisitionHold.SALES_FACING_LABEL.RETRY_WAITING).toMatch(/not automatic/i);
    expect(acquisitionHold.SALES_FACING_LABEL.FAILED_NEEDS_PERSON).toMatch(/operator attention/i);
  });

  test("the disclosure says retry is not automatic", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await acquisitionHold.request({ companyId: A, handover: h, decision: "ACCEPTED" });
    const state = await acquisitionHold.stateFor({ companyId: A, handoverRef: h.handoverRef });
    expect(state.disclosure.retryIsAutomatic).toBe(false);
    expect(state.disclosure.awaitingRetry).toBe(true);
  });

  test("the decision stands through an outage and the operator sweep repairs it", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);

    await salesOutcomeIntake.receive(
      decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble({ failOn: "contactSegments" }) },
    );
    const decided = await Handover.findById(h._id).lean();
    expect(decided.outcome.decision).toBe("ACCEPTED");
    expect(decided.permission.acquisitionPausedAt).toBeNull();

    const failed = await Hold.findOne({ companyId: A }).lean();
    expect(failed.state).toBe("FAILED");
    expect(failed.retryCount).toBe(1);
    expect(failed.nextAttemptAt).toBeInstanceOf(Date);

    const actor = { id: new mongoose.Types.ObjectId(), name: "Ops", email: "ops@grav.in" };
    const summary = await acquisitionHold.resumeUnfinished({
      companyId: A, client: mauticDouble(), actor,
      now: new Date(Date.now() + DELIVERY_RETRY.BASE_MS + 1000),
    });
    expect(summary).toMatchObject({ considered: 1, applied: 1, stillFailed: 0 });

    const applied = await Hold.findOne({ companyId: A }).lean();
    expect(applied.state).toBe("APPLIED");
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt)
      .toEqual(applied.confirmedAt);

    /* The sweep is auditable: the person who asked is on the record. */
    const requested = await MarketingAuditEvent.findOne({
      companyId: A, handoverRef: h.handoverRef, action: "handover.acquisition_hold.retry_requested",
    }).lean();
    expect(requested.actor.name).toBe("Ops");
  });

  test("a sweep nobody requested records no actor", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await acquisitionHold.request({ companyId: A, handover: h, decision: "ACCEPTED" });
    await acquisitionHold.resumeUnfinished({ companyId: A, client: mauticDouble() });
    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, action: "handover.acquisition_hold.retry_requested",
    })).toBe(0);
  });

  test("a transient failure backs off, a terminal one does not, and a spent budget asks for a person", async () => {
    const t = await handoverIn(A);
    await identityIn(A);
    await acquisitionHold.request({ companyId: A, handover: t, decision: "ACCEPTED" });
    await acquisitionHold.apply({
      companyId: A, handoverRef: t.handoverRef, client: mauticDouble({ failOn: "updateContact" }),
    });
    expect((await Hold.findOne({ handoverRef: t.handoverRef })).nextAttemptAt).toBeInstanceOf(Date);

    const term = await handoverIn(A);
    await acquisitionHold.request({ companyId: A, handover: term, decision: "ACCEPTED" });
    await acquisitionHold.apply({
      companyId: A,
      handoverRef: term.handoverRef,
      client: mauticDouble({
        failOn: "updateContact",
        failWith: { code: "MAUTIC_REJECTED_WRITE", message: "Mautic refused the write (400)." },
      }),
    });
    const terminal = await Hold.findOne({ handoverRef: term.handoverRef });
    expect(terminal.activeError.failureClass).toBe("TERMINAL");
    expect(terminal.nextAttemptAt).toBeNull();

    for (let i = 0; i < DELIVERY_RETRY.MAX_ATTEMPTS; i += 1) {
      await Hold.updateOne({ companyId: A, handoverRef: t.handoverRef }, { $set: { nextAttemptAt: null } });
      await acquisitionHold.apply({
        companyId: A, handoverRef: t.handoverRef, client: mauticDouble({ failOn: "updateContact" }),
      });
    }
    const spent = await Hold.findOne({ handoverRef: t.handoverRef }).lean();
    expect(spent.activeError.reasonCode).toBe("RETRY_BUDGET_SPENT");
    expect(acquisitionHold.effectiveState(spent)).toBe("FAILED_NEEDS_PERSON");
  });

  test("a crashed attempt is visible as such, not as one in progress", async () => {
    const h = await handoverIn(A);
    await acquisitionHold.request({ companyId: A, handover: h, decision: "ACCEPTED" });
    await Hold.updateOne(
      { companyId: A, handoverRef: h.handoverRef },
      { $set: { attempts: 1, inFlightSince: new Date(Date.now() - DELIVERY_RETRY.CLAIM_TTL_MS - 1000) } },
    );
    const row = await Hold.findOne({ companyId: A }).lean();
    expect(acquisitionHold.effectiveState(row)).toBe("IN_FLIGHT_STALE");
    expect(acquisitionHold.SALES_FACING_LABEL.IN_FLIGHT_STALE).toMatch(/did not complete/);
  });

  test("a settled command is not re-entered into Mautic", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const client = mauticDouble();
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: client });
    const before = await Hold.findOne({ companyId: A }).lean();
    const callsBefore = client.calls.length;

    for (let i = 0; i < 3; i += 1) {
      const out = await acquisitionHold.apply({ companyId: A, handoverRef: h.handoverRef, client });
      expect(out.changed).toBe(false);
      expect(out.note).toBe("Already APPLIED.");
    }
    const after = await Hold.findOne({ companyId: A }).lean();
    expect(after.attempts).toBe(before.attempts);
    expect(client.calls.length).toBe(callsBefore);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. SUPERSESSION, COMPANY SCOPE AND THE SALES BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("supersession settles without claiming a stop", () => {
  test("consent suppression supersedes an unapplied hold", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await acquisitionHold.request({ companyId: A, handover: h, decision: "ACCEPTED" });
    await consentService.suppress({
      companyId: A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      reason: "unsubscribed", actor: { name: "T" },
    });

    const client = mauticDouble();
    const out = await acquisitionHold.apply({ companyId: A, handoverRef: h.handoverRef, client });
    expect(out.state).toBe("SUPERSEDED");
    expect(out.supersededBy.reason).toBe("CONSENT_SUPPRESSED");
    expect(client.calls).toEqual([]);
    expect(out.confirmedAt).toBeNull();
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt).toBeNull();

    for (let i = 0; i < 3; i += 1) {
      expect(await acquisitionHold.resumeUnfinished({ companyId: A, client: mauticDouble() }))
        .toMatchObject({ considered: 0 });
    }
  });

  test("a newer applied hold supersedes the older command", async () => {
    const older = await handoverIn(A);
    const newer = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await acquisitionHold.request({
      companyId: A, handover: older, decision: "ACCEPTED", now: new Date("2026-09-01T00:00:00Z"),
    });
    await acquisitionHold.request({
      companyId: A, handover: newer, decision: "ACCEPTED", now: new Date("2026-09-09T00:00:00Z"),
    });
    await acquisitionHold.apply({ companyId: A, handoverRef: newer.handoverRef, client: mauticDouble() });

    const out = await acquisitionHold.apply({
      companyId: A, handoverRef: older.handoverRef, client: mauticDouble(),
    });
    expect(out.state).toBe("SUPERSEDED");
    expect(out.supersededBy.handoverRef).toBe(newer.handoverRef);
  });
});

describe("every lookup, retry and reconcile is company-scoped", () => {
  test("company A's recovery does not touch company B's command", async () => {
    const hb = await handoverIn(B);
    await identityIn(B);
    await acquisitionHold.request({ companyId: B, handover: hb, decision: "ACCEPTED" });

    const client = mauticDouble();
    expect(await acquisitionHold.resumeUnfinished({ companyId: A, client }))
      .toMatchObject({ considered: 0, applied: 0 });
    expect(client.calls).toEqual([]);
    expect((await Hold.findOne({ companyId: B })).state).toBe("REQUESTED");
  });

  test("a command pointing at another company's handover resolves nothing and is reported", async () => {
    const ha = await handoverIn(A);
    await identityIn(B);
    await Hold.create({
      companyId: B, handoverRef: ha.handoverRef, handoverId: ha._id,
      gravPersonKey: KEY, reason: "SALES_ACCEPTED", requestedAt: new Date(), state: "REQUESTED",
    });

    const client = mauticDouble();
    const summary = await acquisitionHold.resumeUnfinished({ companyId: B, client });
    expect(summary.applied).toBe(0);
    expect(summary.stillFailed).toBe(1);
    expect(summary.integrity[0].reason).toMatch(/no handover belonging to this company/);
    expect(client.calls).toEqual([]);
    expect((await Handover.findById(ha._id)).permission.acquisitionPausedAt).toBeNull();
  });

  test("reading or applying without a company is refused outright", async () => {
    for (const fn of [
      () => acquisitionHold.stateFor({ handoverRef: "MHO-2026-0001" }),
      () => acquisitionHold.resumeUnfinished({}),
      () => acquisitionHold.healthSummary({}),
    ]) {
      await expect(fn()).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    }
  });

  test("two companies can hold the same handover reference, but one company cannot twice", async () => {
    const ha = await handoverIn(A);
    const row = {
      handoverRef: ha.handoverRef, gravPersonKey: KEY, reason: "SALES_ACCEPTED",
      requestedAt: new Date(), state: "REQUESTED",
    };
    await Hold.create({ companyId: A, ...row });
    await expect(Hold.create({ companyId: B, ...row })).resolves.toBeDefined();
    await expect(Hold.create({ companyId: A, ...row })).rejects.toMatchObject({ code: 11000 });
  });
});

describe("the Sales lifecycle and the audit trail", () => {
  test("no Sales lifecycle record is created or moved by any of this", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    const lead = await Lead.create({
      leadId: "LEAD-2026-7001", companyId: A, company: "Aurora Hotels Pvt Ltd",
      firstName: "Meera", captureStatus: "draft", isActive: true,
    });

    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });
    await acquisitionHold.resumeUnfinished({ companyId: A, client: mauticDouble() });

    const after = await Lead.findById(lead._id).lean();
    expect(after.captureStatus).toBe("draft");
    expect(after.reviewStatus).toBe("researching");
    expect(after.qualificationState).toBe("new");
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("each transition leaves one audit line and no invented Marketing actor", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await acquisitionHold.request({ companyId: A, handover: h, decision: "ACCEPTED" });
    await acquisitionHold.apply({
      companyId: A, handoverRef: h.handoverRef, client: mauticDouble({ failOn: "updateContact" }),
    });
    await Hold.updateOne({ companyId: A, handoverRef: h.handoverRef }, { $set: { nextAttemptAt: null } });
    await acquisitionHold.apply({ companyId: A, handoverRef: h.handoverRef, client: mauticDouble() });

    const trail = await MarketingAuditEvent
      .find({ companyId: A, handoverRef: h.handoverRef }).sort({ at: 1, _id: 1 }).lean();
    expect(trail.map((t) => t.action)).toEqual([
      "handover.acquisition_hold.failed", "handover.acquisition_hold.applied",
    ]);
    for (const line of trail) expect(line.actor?.name).toBeUndefined();
    expect(trail[1].details.segmentsRemoved).toEqual([String(ACQ_SEGMENT)]);
    expect(trail[1].details.exclusionsGuarded).toEqual([String(ACQ_SEGMENT)]);
  });

  test("health counts promises and facts separately, per company", async () => {
    const done = await handoverIn(A);
    const owed = await handoverIn(A);
    await identityIn(A);
    await grantIn(A);
    await acquisitionHold.request({ companyId: A, handover: done, decision: "ACCEPTED" });
    await acquisitionHold.apply({ companyId: A, handoverRef: done.handoverRef, client: mauticDouble() });
    await acquisitionHold.request({ companyId: A, handover: owed, decision: "ACCEPTED" });

    expect(await acquisitionHold.healthSummary({ companyId: A }))
      .toMatchObject({ total: 2, applied: 1, unfinished: 1, superseded: 0 });
    expect(await acquisitionHold.healthSummary({ companyId: B }))
      .toMatchObject({ total: 0, applied: 0, unfinished: 0, oldestUnfinishedAt: null });
  });

  test("the failure a reader sees is a code and an operator sentence, never a provider body", async () => {
    const h = await handoverIn(A);
    await identityIn(A);
    await acquisitionHold.request({ companyId: A, handover: h, decision: "ACCEPTED" });
    await acquisitionHold.apply({
      companyId: A,
      handoverRef: h.handoverRef,
      client: mauticDouble({
        failOn: "contactSegments",
        failWith: { code: "MAUTIC_UNAVAILABLE", message: "x".repeat(900) },
      }),
    });

    const state = await acquisitionHold.stateFor({ companyId: A, handoverRef: h.handoverRef });
    expect(state.failure.message.length).toBeLessThanOrEqual(500);
    expect(Object.keys(state.failure).sort()).toEqual(["at", "failureClass", "message", "reasonCode"]);
  });

  test("the schema refuses a confirmation on anything but APPLIED", () => {
    expect(acquisitionHold.UNFINISHED_STATES).toEqual(["REQUESTED", "FAILED"]);
    expect(Hold.invariantViolation({ state: "REQUESTED", confirmedAt: new Date(), attempts: 1 }))
      .toMatch(/cannot carry a confirmation time/);
    expect(Hold.invariantViolation({ state: "APPLIED", confirmedAt: null, attempts: 1 }))
      .toMatch(/must carry the time Mautic confirmed it/);
  });

  test("a person with no proven Mautic contact fails terminally rather than claiming a pause", async () => {
    const h = await handoverIn(A);
    await salesOutcomeIntake.receive(decisionEvent(A, h.handoverRef), { mauticClient: mauticDouble() });

    const hold = await Hold.findOne({ companyId: A }).lean();
    expect(hold.gravPersonKey).toBe(`unresolved:${h.handoverRef}`);
    expect(hold.state).toBe("FAILED");
    expect(hold.activeError.failureClass).toBe("TERMINAL");
    expect(hold.nextAttemptAt).toBeNull();
    expect((await Handover.findById(h._id)).permission.acquisitionPausedAt).toBeNull();
  });
});
