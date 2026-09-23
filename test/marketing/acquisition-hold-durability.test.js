// test/marketing/acquisition-hold-durability.test.js
//
// THREE GAPS BETWEEN A DECISION AND ITS CONSEQUENCES.
//
// Each describe block reproduces a window in which a fact was stored and the
// thing it was supposed to cause was not, then proves the system closes it
// rather than reporting success.
//
//   1. Sales' decision saved, its outcome announcement never created — and a
//      retry refused to try again, so Marketing never heard at all.
//   2. An acquisition segment registered in configuration and unguarded in
//      Mautic, so a held person could be enrolled again.
//   3. Two concurrent replays both passing an `exists()` check and writing two
//      identical decision-audit rows.
"use strict";

const mongoose = require("mongoose");

jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const decisions = require("../../services/sales/marketingHandoverDecision.service");
const outcomeDelivery = require("../../services/integration/marketingOutcomeDelivery.service");
const acquisitionHold = require("../../services/marketing/acquisitionHold.service");
const registration = require("../../services/marketing/acquisitionRegistration.service");
const salesOutcomeIntake = require("../../services/marketing/salesOutcomeIntake.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const mauticHealth = require("../../services/marketing/mauticHealth.service");

const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingAuditEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingConsent, MarketingConsentHistory } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const {
  MarketingHandoverReceipt, SalesMarketingOutcomeOutboxEvent,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { ACQUISITION_HOLD_FIELD } = require("../../constants/marketing");

const KEY = "grav-person-durability";
const EMAIL = "durability@aurorahotels.in";
const CONTACT = "901";

const ACQ_SEGMENT = 21;
const ACQ_CAMPAIGN = 31;
const NEW_ACQ_SEGMENT = 22;
const NEW_ACQ_CAMPAIGN = 32;
const SERVICE_SEGMENT = 23;
const SERVICE_CAMPAIGN = 33;

const SELLER = { id: new mongoose.Types.ObjectId(), name: "Seller", email: "seller@grav.in" };

/* Enough Mautic configuration for the health check to get past its first step
   and reach the acquisition-scope check. No request is made: the double stands
   in for the client. */
const HEALTHY_ENV = Object.freeze({
  MAUTIC_BASE_URL: "http://localhost:8088",
  MAUTIC_AUTH_MODE: "basic",
  MAUTIC_BASIC_USERNAME: "grav-integration",
  MAUTIC_BASIC_PASSWORD: "not-used-by-the-double",
});

let A;
let B;
const SCOPE_KEYS = ["MAUTIC_ACQUISITION_SEGMENTS", "MAUTIC_ACQUISITION_CAMPAIGNS"];
const savedEnv = {};

/* The same shape the other acquisition suites use, with the instance registry
   the registration operation needs to resolve and guard. */
function mauticDouble({
  contactSegments = [{ id: ACQ_SEGMENT, alias: "acq" }, { id: SERVICE_SEGMENT, alias: "service" }],
  contactCampaigns = [{ id: ACQ_CAMPAIGN, alias: "acq-journey" }, { id: SERVICE_CAMPAIGN, alias: "service-journey" }],
  instanceSegments = [
    { id: ACQ_SEGMENT, alias: "acq", name: "Acquisition", filters: [] },
    { id: NEW_ACQ_SEGMENT, alias: "acq-two", name: "Acquisition wave two", filters: [] },
    { id: SERVICE_SEGMENT, alias: "service", name: "Service", filters: [] },
  ],
  instanceCampaigns = [
    { id: ACQ_CAMPAIGN, alias: "acq-journey", name: "Acquisition", lists: [{ id: ACQ_SEGMENT }] },
    { id: NEW_ACQ_CAMPAIGN, alias: "acq-two-journey", name: "Acquisition two", lists: [{ id: NEW_ACQ_SEGMENT }] },
    { id: SERVICE_CAMPAIGN, alias: "service-journey", name: "Service", lists: [{ id: SERVICE_SEGMENT }] },
  ],
  failOn = null,
  failWith = { code: "MAUTIC_UNAVAILABLE", message: "Mautic did not respond." },
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
    async listSegments() { calls.push({ call: "listSegments" }); maybeFail("listSegments"); return state.instanceSegments; },
    async listCampaigns() { calls.push({ call: "listCampaigns" }); maybeFail("listCampaigns"); return state.instanceCampaigns; },
    async getSegment(id) { calls.push({ call: "getSegment", id: String(id) }); maybeFail("getSegment"); return find(state.instanceSegments, id) || null; },
    async updateSegment(id, fields) {
      calls.push({ call: "updateSegment", id: String(id), fields });
      maybeFail("updateSegment");
      Object.assign(find(state.instanceSegments, id), fields);
      return find(state.instanceSegments, id);
    },
    async getCampaign(id) { calls.push({ call: "getCampaign", id: String(id) }); maybeFail("getCampaign"); return find(state.instanceCampaigns, id) || null; },
    async updateContact(id, fields) { calls.push({ call: "updateContact", id: String(id), fields }); maybeFail("updateContact"); Object.assign(state.fields, fields); return { id }; },
    async getContact(id) { calls.push({ call: "getContact", id: String(id) }); maybeFail("getContact"); return { id, fields: { all: { ...state.fields } } }; },
    async contactSegments(id) { calls.push({ call: "contactSegments", id: String(id) }); maybeFail("contactSegments"); return state.segments; },
    async contactCampaigns(id) { calls.push({ call: "contactCampaigns", id: String(id) }); maybeFail("contactCampaigns"); return state.campaigns; },
    async removeContactFromSegment(segmentId, id) {
      calls.push({ call: "removeContactFromSegment", segmentId: String(segmentId), id: String(id) });
      maybeFail("removeContactFromSegment");
      state.segments = state.segments.filter((x) => String(x.id) !== String(segmentId));
      return { success: true };
    },
    async removeContactFromCampaign(campaignId, id) {
      calls.push({ call: "removeContactFromCampaign", campaignId: String(campaignId), id: String(id) });
      maybeFail("removeContactFromCampaign");
      state.campaigns = state.campaigns.filter((x) => String(x.id) !== String(campaignId));
      return { success: true };
    },
  };
}

beforeAll(() => { for (const k of SCOPE_KEYS) savedEnv[k] = process.env[k]; });
const restoreEnv = () => {
  for (const k of SCOPE_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};
afterEach(restoreEnv);
afterAll(restoreEnv);

beforeEach(async () => {
  A = new mongoose.Types.ObjectId();
  B = new mongoose.Types.ObjectId();
  process.env.MAUTIC_ACQUISITION_SEGMENTS = String(ACQ_SEGMENT);
  process.env.MAUTIC_ACQUISITION_CAMPAIGNS = String(ACQ_CAMPAIGN);
  await Hold.syncIndexes();
  await MarketingAuditEvent.syncIndexes();
  await SalesMarketingOutcomeOutboxEvent.syncIndexes();
  await MarketingConsentHistory.syncIndexes();
});

let seq = 0;
/* Both sides of one handover: Marketing's record and Sales' receipt. */
async function handoverPair(companyId) {
  seq += 1;
  const ref = `MHO-2026-${String(6000 + seq)}`;
  const lead = await Lead.create({
    leadId: `LEAD-2026-${String(6000 + seq)}`, companyId, company: "Aurora Hotels Pvt Ltd",
    firstName: "Meera", captureStatus: "draft", isActive: true,
  });
  const handover = await Handover.create({
    companyId, handoverRef: ref, state: "AWAITING_REVIEW",
    company: { name: "Aurora Hotels Pvt Ltd", domain: "aurorahotels.in" },
    person: { firstName: "Meera", workEmail: EMAIL },
    matchKeys: { normalizedEmail: EMAIL, externalContactId: CONTACT },
    assessment: { handoverReason: "Asked for a quotation.", recommendedAction: "call_within_one_business_day" },
    correlationId: `corr-${ref}`, submittedAt: new Date(),
  });
  const receipt = await MarketingHandoverReceipt.create({
    companyId, handoverRef: ref, receivedAt: new Date(), intakeOutcome: "CREATED",
    leadId: lead._id, leadRef: lead.leadId, correlationId: `corr-${ref}`,
    package: { assessment: { handoverReason: "Asked for a quotation." } },
  });
  if (!(await MarketingIdentity.exists({ companyId, gravPersonKey: KEY }))) {
    await MarketingIdentity.create({
      companyId, gravPersonKey: KEY, email: EMAIL, salesLeadId: lead._id,
      externals: [{ system: "mautic", externalId: CONTACT, proven: true }],
    });
    await consentService.record({
      companyId, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      state: "opted_in", capturedSource: "test", actor: { name: "T" },
    });
  }
  return { ref, handover, receipt, lead };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE SALES DECISION AND ITS ANNOUNCEMENT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a Sales decision can never be left without its announcement", () => {
  test("a decision stored with no outbox row is repaired by replaying the same decision", async () => {
    const { ref, lead } = await handoverPair(A);

    /* ── THE EXACT WINDOW ─────────────────────────────────────────────────
       `decide` saves the Lead, saves the receipt's decision, then creates the
       outbox row. Failing the third step leaves the decision stored and
       Marketing permanently uninformed — and the old guard then refused every
       retry with INVALID_TRANSITION, so the announcement could never be made. */
    const spy = jest.spyOn(SalesMarketingOutcomeOutboxEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost before the announcement was written"));

    await expect(decisions.decide({
      companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
    })).rejects.toThrow(/connection lost/);
    spy.mockRestore();

    const stranded = await MarketingHandoverReceipt.findOne({ companyId: A, handoverRef: ref }).lean();
    expect(stranded.decision).toBe("ACCEPTED");
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(0);
    /* The Lead was assigned, so the decision really did take effect on Sales. */
    expect(String((await Lead.findById(lead._id)).assignedTo)).toBe(String(SELLER.id));

    /* ── THE REPAIR: THE SAME DECISION AGAIN ──────────────────────────────── */
    const replay = await decisions.decide({
      companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.outcomeEventRepaired).toBe(true);

    const events = await SalesMarketingOutcomeOutboxEvent.find({ companyId: A }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].payload.decision).toBe("ACCEPTED");
    expect(events[0].payload.handoverRef).toBe(ref);
    expect(events[0].status).toBe("PENDING");

    /* The original decision is preserved exactly. */
    const after = await MarketingHandoverReceipt.findOne({ companyId: A, handoverRef: ref }).lean();
    expect(after.decidedAt).toEqual(stranded.decidedAt);
    expect(String(after.decidedBy.id)).toBe(String(stranded.decidedBy.id));
    expect(after.decisionReason).toBe(stranded.decisionReason);
    expect(String(after.assignedTo)).toBe(String(stranded.assignedTo));
  });

  test("delivering that repaired event makes Marketing raise exactly one hold", async () => {
    const { ref } = await handoverPair(A);
    const spy = jest.spyOn(SalesMarketingOutcomeOutboxEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(decisions.decide({
      companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
    })).rejects.toThrow();
    spy.mockRestore();

    await decisions.decide({ companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER });
    const delivered = await outcomeDelivery.deliverPending({ companyId: A });
    expect(delivered).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });

    const holds = await Hold.find({ companyId: A }).lean();
    expect(holds).toHaveLength(1);
    expect(holds[0].handoverRef).toBe(ref);
    expect(holds[0].reason).toBe("SALES_ACCEPTED");
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A, status: "PENDING" })).toBe(0);

    /* Three further replays of the whole chain change nothing. */
    for (let i = 0; i < 3; i += 1) {
      const again = await decisions.decide({
        companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
      });
      expect(again.duplicate).toBe(true);
      expect(again.outcomeEventRepaired).toBe(false);
      await outcomeDelivery.deliverPending({ companyId: A });
    }
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(1);
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, handoverRef: ref, action: "handover.accepted",
    })).toBe(1);
  });

  test("a DIFFERENT decision is still refused", async () => {
    const { ref } = await handoverPair(A);
    await decisions.decide({ companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER });

    await expect(decisions.decide({
      companyId: A, handoverRef: ref, decision: "REJECTED", reason: "changed my mind", actor: SELLER,
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    expect((await MarketingHandoverReceipt.findOne({ companyId: A, handoverRef: ref })).decision)
      .toBe("ACCEPTED");
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(1);
  });

  test("the reconciliation query finds decided receipts missing their announcement", async () => {
    const stranded = await handoverPair(A);
    const healthy = await handoverPair(A);

    const spy = jest.spyOn(SalesMarketingOutcomeOutboxEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(decisions.decide({
      companyId: A, handoverRef: stranded.ref, decision: "ACCEPTED", actor: SELLER,
    })).rejects.toThrow();
    spy.mockRestore();
    await decisions.decide({ companyId: A, handoverRef: healthy.ref, decision: "ACCEPTED", actor: SELLER });

    /* The scan now returns its own metadata alongside the rows: a caller must be
       able to tell "found nothing" from "stopped looking". */
    const missing = await decisions.decidedReceiptsMissingOutcomeEvent({ companyId: A });
    expect(missing.rows.map((r) => r.handoverRef)).toEqual([stranded.ref]);
    expect(missing.complete).toBe(true);
    expect(missing.examined).toBe(2);

    /* And company B sees none of it. */
    const none = await decisions.decidedReceiptsMissingOutcomeEvent({ companyId: B });
    expect(none.rows).toEqual([]);
    expect(none.examined).toBe(0);
    expect(none.complete).toBe(true);
    await expect(decisions.decidedReceiptsMissingOutcomeEvent({})).rejects.toMatchObject({
      code: "TENANT_MEMBERSHIP_UNPROVEN",
    });
  });

  test("the delivery sweep repairs before it delivers, so no replay is needed", async () => {
    const { ref } = await handoverPair(A);
    const spy = jest.spyOn(SalesMarketingOutcomeOutboxEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(decisions.decide({
      companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
    })).rejects.toThrow();
    spy.mockRestore();
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(0);

    /* Nobody replays the decision. The ordinary sweep notices and repairs. */
    const summary = await outcomeDelivery.deliverPending({ companyId: A });
    expect(summary.repairedOutcomeEvents).toBe(1);
    expect(summary).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
  });

  test("concurrent replays create one announcement, one hold and one decision audit", async () => {
    const { ref } = await handoverPair(A);
    const spy = jest.spyOn(SalesMarketingOutcomeOutboxEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(decisions.decide({
      companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
    })).rejects.toThrow();
    spy.mockRestore();

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => decisions.decide({
      companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER,
    })));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(1);

    await Promise.allSettled(Array.from({ length: 6 }, () => outcomeDelivery.deliverPending({ companyId: A })));
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, handoverRef: ref, action: "handover.accepted",
    })).toBe(1);
  });

  test("the decision, the announcement and the hold leave the Sales lifecycle alone", async () => {
    const { ref, lead } = await handoverPair(A);
    await decisions.decide({ companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER });
    await outcomeDelivery.deliverPending({ companyId: A });

    const after = await Lead.findById(lead._id).lean();
    expect(after.captureStatus).toBe("draft");
    expect(after.reviewStatus).toBe("researching");
    expect(after.qualificationState).toBe("new");
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. REGISTRATION IS AN OPERATION WITH A COMPLETION CONDITION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a configured acquisition scope is not a registered one", () => {
  test("declaring a new segment without registering it is reported NOT READY", async () => {
    const client = mauticDouble();
    /* Registration ran for the first segment. */
    const first = await registration.register({ companyId: A, client });
    expect(first.ready).toBe(true);

    /* Somebody edits the variables to add the second. Nothing in Mautic changes. */
    process.env.MAUTIC_ACQUISITION_SEGMENTS = `${ACQ_SEGMENT},${NEW_ACQ_SEGMENT}`;
    process.env.MAUTIC_ACQUISITION_CAMPAIGNS = `${ACQ_CAMPAIGN},${NEW_ACQ_CAMPAIGN}`;

    const inspected = await registration.inspect({ client });
    expect(inspected.configured).toBe(true);
    expect(inspected.ready).toBe(false);
    expect(inspected.unguardedSegments).toEqual([String(NEW_ACQ_SEGMENT)]);
    expect(inspected.reason).toMatch(/editing the environment variables alone does not register/i);
  });

  test("running the registration operation makes it ready, and verifies every step", async () => {
    const client = mauticDouble();
    process.env.MAUTIC_ACQUISITION_SEGMENTS = `${ACQ_SEGMENT},${NEW_ACQ_SEGMENT}`;
    process.env.MAUTIC_ACQUISITION_CAMPAIGNS = `${ACQ_CAMPAIGN},${NEW_ACQ_CAMPAIGN}`;

    const report = await registration.register({ companyId: A, client });
    expect(report.ready).toBe(true);
    expect(report.guardedSegments.sort()).toEqual([String(ACQ_SEGMENT), String(NEW_ACQ_SEGMENT)].sort());
    expect(report.exclusionsAdded.sort()).toEqual([String(ACQ_SEGMENT), String(NEW_ACQ_SEGMENT)].sort());
    expect(report.campaignsVerified.sort()).toEqual([String(ACQ_CAMPAIGN), String(NEW_ACQ_CAMPAIGN)].sort());

    for (const id of [ACQ_SEGMENT, NEW_ACQ_SEGMENT]) {
      const seg = client.state.instanceSegments.find((x) => String(x.id) === String(id));
      expect(seg.filters.some((f) => f.field === ACQUISITION_HOLD_FIELD && f.operator === "!=")).toBe(true);
    }
    /* The service segment's definition is never touched. */
    expect(client.state.instanceSegments.find((x) => String(x.id) === String(SERVICE_SEGMENT)).filters)
      .toEqual([]);

    expect(await registration.inspect({ client })).toMatchObject({ configured: true, ready: true });
  });

  test("registration reconciles an already-held contact against the newly registered scope", async () => {
    /* A hold applied when only the first path was registered, and the person is
       sitting in the second path because it did not exist yet. */
    const { ref } = await handoverPair(A);
    const client = mauticDouble({
      contactSegments: [{ id: NEW_ACQ_SEGMENT, alias: "acq-two" }, { id: SERVICE_SEGMENT, alias: "service" }],
      contactCampaigns: [{ id: NEW_ACQ_CAMPAIGN, alias: "acq-two-journey" }, { id: SERVICE_CAMPAIGN, alias: "service-journey" }],
    });
    const confirmedAt = new Date("2026-08-01T00:00:00Z");
    await Hold.create({
      companyId: A, handoverRef: ref, gravPersonKey: KEY, mauticContactId: CONTACT,
      reason: "SALES_ACCEPTED", requestedAt: confirmedAt, state: "APPLIED",
      confirmedAt, attempts: 1,
      evidence: { holdFieldSet: true, segmentsRemoved: [String(ACQ_SEGMENT)], exclusionsGuarded: [String(ACQ_SEGMENT)] },
    });

    process.env.MAUTIC_ACQUISITION_SEGMENTS = `${ACQ_SEGMENT},${NEW_ACQ_SEGMENT}`;
    process.env.MAUTIC_ACQUISITION_CAMPAIGNS = `${ACQ_CAMPAIGN},${NEW_ACQ_CAMPAIGN}`;

    const report = await registration.register({ companyId: A, client });
    expect(report.ready).toBe(true);
    expect(report.holdsReconciled).toMatchObject({ examined: 1, corrected: 1, failed: 0 });

    /* The newly in-scope memberships are gone; the service path survives. */
    expect(client.state.segments.map((x) => String(x.id))).toEqual([String(SERVICE_SEGMENT)]);
    expect(client.state.campaigns.map((x) => String(x.id))).toEqual([String(SERVICE_CAMPAIGN)]);

    const hold = await Hold.findOne({ companyId: A, handoverRef: ref }).lean();
    expect(hold.evidence.segmentsRemoved.sort()).toEqual([String(ACQ_SEGMENT), String(NEW_ACQ_SEGMENT)].sort());
    /* The stop was confirmed when it was confirmed. Extending it over newly
       registered ground does not re-date it. */
    expect(hold.confirmedAt).toEqual(confirmedAt);
    expect(hold.state).toBe("APPLIED");

    const rescoped = await MarketingAuditEvent.findOne({
      companyId: A, handoverRef: ref, action: "handover.acquisition_hold.rescoped",
    }).lean();
    expect(rescoped.details.segmentsRemoved).toEqual([String(NEW_ACQ_SEGMENT)]);
  });

  test("registration refuses when an acquisition campaign draws from an unregistered segment", async () => {
    const client = mauticDouble({
      instanceCampaigns: [{
        id: ACQ_CAMPAIGN, alias: "acq-journey", name: "Acquisition",
        lists: [{ id: ACQ_SEGMENT }, { id: SERVICE_SEGMENT }],
      }],
    });
    const report = await registration.register({ companyId: A, client });
    expect(report.ready).toBe(false);
    expect(report.problems[0].code).toBe("ACQUISITION_SCOPE_UNVERIFIABLE");
    expect(report.problems[0].message).toMatch(/not registered acquisition segments/);
  });

  test("registration refuses when nothing is declared, and says so without guessing", async () => {
    for (const k of SCOPE_KEYS) delete process.env[k];
    const client = mauticDouble();
    const report = await registration.register({ companyId: A, client });
    expect(report.ready).toBe(false);
    expect(report.problems[0].code).toBe("ACQUISITION_SCOPE_MISSING");
    expect(client.calls.some((c) => c.call === "updateSegment")).toBe(false);
  });

  test("unregistered automation is reported as drift, not treated as covered", async () => {
    const client = mauticDouble();
    const report = await registration.register({ companyId: A, client });
    expect(report.ready).toBe(true);
    /* The second acquisition path and the service path are both unregistered
       here, and GRAV says so rather than implying it protects them. */
    expect(report.unregisteredAutomation.segments.map((x) => x.id).sort())
      .toEqual([String(NEW_ACQ_SEGMENT), String(SERVICE_SEGMENT)].sort());
    expect(report.unregisteredAutomation.campaigns.map((x) => x.id).sort())
      .toEqual([String(NEW_ACQ_CAMPAIGN), String(SERVICE_CAMPAIGN)].sort());
  });

  test("health reports a configured-but-unguarded scope as unhealthy", async () => {
    const client = mauticDouble();
    await registration.register({ companyId: A, client });

    /* A configured Mautic, so health reaches the acquisition check instead of
       stopping at the configuration one. */
    const env = {
      ...HEALTHY_ENV,
      MAUTIC_ACQUISITION_SEGMENTS: `${ACQ_SEGMENT},${NEW_ACQ_SEGMENT}`,
      MAUTIC_ACQUISITION_CAMPAIGNS: String(ACQ_CAMPAIGN),
    };
    const health = await mauticHealth.check({ client, env });
    expect(health.checks.acquisitionScope.state).toBe("failed");
    expect(health.healthy).toBe(false);
    expect(health.acquisitionScope.unguardedSegments).toEqual([String(NEW_ACQ_SEGMENT)]);
    expect(health.checks.acquisitionScope.detail).toMatch(/registration operation/i);
  });

  test("health reports a registered and enforced scope as ok, and names the drift", async () => {
    const client = mauticDouble();
    const env = {
      ...HEALTHY_ENV,
      MAUTIC_ACQUISITION_SEGMENTS: String(ACQ_SEGMENT),
      MAUTIC_ACQUISITION_CAMPAIGNS: String(ACQ_CAMPAIGN),
    };
    await registration.register({ companyId: A, client, env });
    const health = await mauticHealth.check({ client, env });
    expect(health.checks.acquisitionScope.state).toBe("ok");
    expect(health.healthy).toBe(true);
    /* And it says out loud what it does NOT guarantee. */
    expect(health.checks.acquisitionScope.detail).toMatch(/unregistered/i);
  });

  test("health treats an undeclared scope as not configured rather than broken", async () => {
    const client = mauticDouble();
    const health = await mauticHealth.check({ client, env: HEALTHY_ENV });
    expect(health.checks.acquisitionScope.state).toBe("not_configured");
    expect(health.acquisitionScope.ready).toBe(false);
    /* Not configured is a legitimate state before Chunk 3 is switched on, so it
       does not make the integration unhealthy. */
    expect(health.healthy).toBe(true);
  });

  test("registration is company-scoped and refuses without one", async () => {
    await expect(registration.register({ client: mauticDouble() })).rejects.toMatchObject({
      code: "TENANT_MEMBERSHIP_UNPROVEN",
    });
  });

  test("one company's registration does not reconcile another's holds", async () => {
    const { ref } = await handoverPair(B);
    await Hold.create({
      companyId: B, handoverRef: ref, gravPersonKey: KEY, mauticContactId: CONTACT,
      reason: "SALES_ACCEPTED", requestedAt: new Date(), state: "APPLIED",
      confirmedAt: new Date(), attempts: 1,
      evidence: { holdFieldSet: true },
    });
    const client = mauticDouble();
    const report = await registration.register({ companyId: A, client });
    expect(report.holdsReconciled.examined).toBe(0);
    expect(client.calls.some((c) => c.call.startsWith("removeContactFrom"))).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE ONE-TIME AUDIT FACT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a one-time audit fact is written once, enforced by the database", () => {
  test("the index refuses a second decision audit for the same handover", async () => {
    const { ref, handover } = await handoverPair(A);
    const row = {
      companyId: A, handoverRef: ref, handoverId: handover._id, action: "handover.accepted",
      at: new Date(), resultingState: "ACCEPTED", correlationId: `${ref}:decision`,
      dedupeKey: `${ref}:decision:accepted`,
    };
    await MarketingAuditEvent.create(row);
    await expect(MarketingAuditEvent.create(row)).rejects.toMatchObject({ code: 11000 });
    /* Another company may hold the same key. */
    await expect(MarketingAuditEvent.create({ ...row, companyId: B })).resolves.toBeDefined();
  });

  test("per-attempt audit rows carry no key and may repeat as the attempts did", async () => {
    const { ref, handover } = await handoverPair(A);
    const attempt = {
      companyId: A, handoverRef: ref, handoverId: handover._id,
      action: "handover.acquisition_hold.failed", at: new Date(),
      resultingState: "FAILED", correlationId: `${ref}:acquisition-hold`,
    };
    await MarketingAuditEvent.create(attempt);
    await MarketingAuditEvent.create(attempt);
    await MarketingAuditEvent.create(attempt);
    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, handoverRef: ref, action: "handover.acquisition_hold.failed",
    })).toBe(3);
  });

  test("concurrent decision deliveries write exactly one decision audit", async () => {
    const { ref } = await handoverPair(A);
    await decisions.decide({ companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER });
    const event = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: A }).lean();

    /* Eight deliveries of the same decision at once. The old `exists()` then
       `create()` could let several through. */
    await Promise.allSettled(Array.from({ length: 8 }, () => salesOutcomeIntake.receive(
      { ...event, companyId: A }, { mauticClient: mauticDouble() },
    )));

    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, handoverRef: ref, action: "handover.accepted",
    })).toBe(1);
    expect(await Hold.countDocuments({ companyId: A })).toBe(1);
  });

  test("a duplicate key that matches nothing is re-raised, not called success", async () => {
    const { ref, handover } = await handoverPair(A);
    /* A real duplicate-key error whose key belongs to no matching audit row: the
       writer must not read "11000" as "somebody else already did my work". */
    const spy = jest.spyOn(MarketingAuditEvent, "findOne").mockReturnValue({
      lean: async () => null,
    });
    const createSpy = jest.spyOn(MarketingAuditEvent, "create")
      .mockRejectedValue(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));

    await expect(salesOutcomeIntake.reconcileDecisionSideEffects({
      companyId: A,
      handover: { ...handover.toObject(), outcome: { decision: "ACCEPTED", decidedAt: new Date() } },
      event: { correlationId: `${ref}:decision` },
      mauticClient: mauticDouble(),
    })).rejects.toMatchObject({ code: 11000 });

    createSpy.mockRestore();
    spy.mockRestore();
  });

  test("consent and its history are untouched by the whole chain", async () => {
    const { ref } = await handoverPair(A);
    const before = await MarketingConsent.findOne({ companyId: A, gravPersonKey: KEY }).lean();
    const historyBefore = await MarketingConsentHistory.countDocuments({ companyId: A, gravPersonKey: KEY });

    await decisions.decide({ companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER });
    await outcomeDelivery.deliverPending({ companyId: A });
    await decisions.decide({ companyId: A, handoverRef: ref, decision: "ACCEPTED", actor: SELLER });

    const after = await MarketingConsent.findOne({ companyId: A, gravPersonKey: KEY }).lean();
    expect(after.state).toBe("opted_in");
    expect(after.revision).toBe(before.revision);
    expect(await MarketingConsentHistory.countDocuments({ companyId: A, gravPersonKey: KEY }))
      .toBe(historyBefore);
    expect((await consentService.resolveEffective({
      companyId: A, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
    })).eligible).toBe(true);
  });

  test("cross-company recovery of a drifted hold resolves nothing", async () => {
    const { ref, handover } = await handoverPair(A);
    await Hold.create({
      companyId: B, handoverRef: ref, handoverId: handover._id, gravPersonKey: KEY,
      reason: "SALES_ACCEPTED", requestedAt: new Date(), state: "REQUESTED",
    });
    const client = mauticDouble();
    const summary = await acquisitionHold.resumeUnfinished({ companyId: B, client });
    expect(summary.applied).toBe(0);
    expect(summary.stillFailed).toBe(1);
    expect(summary.integrity[0].reason).toMatch(/no handover belonging to this company/);
    expect(client.calls).toEqual([]);
  });
});
