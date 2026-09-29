// test/marketing/acquisition-hold-scoping.test.js
//
// THREE WAYS A BOUND OR A KEY WAS WRONG.
//
//   1. An announcement's identity was global, so two companies sharing a
//      correlation identity would read and suppress each other's event.
//   2. The missing-announcement scan bounded the rows it READ rather than the
//      missing rows it FOUND, so a gap past the first page was never looked at
//      and every sweep reported a clean run.
//   3. Registration checked one page of applied holds and then called the scope
//      ready, leaving an unexamined contact inside the newly registered
//      acquisition automation.
//
// Every test here uses a deliberately small page size, because a bound is only
// ever wrong beyond itself.
"use strict";

const mongoose = require("mongoose");

jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const decisions = require("../../services/sales/marketingHandoverDecision.service");
const outcomeDelivery = require("../../services/integration/marketingOutcomeDelivery.service");
const registration = require("../../services/marketing/acquisitionRegistration.service");
const consentService = require("../../services/marketing/marketingConsent.service");

const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingAuditEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const {
  MarketingHandoverReceipt, SalesMarketingOutcomeOutboxEvent,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { SALES_OUTCOME_EVENT_KINDS, ACQUISITION_HOLD_FIELD } = require("../../constants/marketing");

const ACQ_SEGMENT = 41;
const ACQ_CAMPAIGN = 51;
const NEW_ACQ_SEGMENT = 42;
const SERVICE_SEGMENT = 43;
const SERVICE_CAMPAIGN = 53;

const SELLER = { id: new mongoose.Types.ObjectId(), name: "Seller", email: "seller@grav.in" };

let A;
let B;
const SCOPE_KEYS = ["MAUTIC_ACQUISITION_SEGMENTS", "MAUTIC_ACQUISITION_CAMPAIGNS"];
const savedEnv = {};

/* Per-contact membership is keyed by contact id here, because the hold
   reconciliation walks several contacts in one run and each must be able to
   differ from the others. */
function mauticDouble({
  perContact = {},
  instanceSegments = [
    { id: ACQ_SEGMENT, alias: "acq", name: "Acquisition", filters: [] },
    { id: NEW_ACQ_SEGMENT, alias: "acq-two", name: "Acquisition two", filters: [] },
    { id: SERVICE_SEGMENT, alias: "service", name: "Service", filters: [] },
  ],
  instanceCampaigns = [
    { id: ACQ_CAMPAIGN, alias: "acq-journey", name: "Acquisition", lists: [{ id: ACQ_SEGMENT }] },
    { id: SERVICE_CAMPAIGN, alias: "service-journey", name: "Service", lists: [{ id: SERVICE_SEGMENT }] },
  ],
} = {}) {
  const state = {
    perContact: Object.fromEntries(Object.entries(perContact).map(([k, v]) => [String(k), {
      segments: [...(v.segments || [])], campaigns: [...(v.campaigns || [])], fields: { ...(v.fields || {}) },
    }])),
    instanceSegments: instanceSegments.map((x) => ({ ...x, filters: [...(x.filters || [])] })),
    instanceCampaigns: instanceCampaigns.map((x) => ({ ...x })),
  };
  const calls = [];
  const of = (id) => {
    const k = String(id);
    if (!state.perContact[k]) state.perContact[k] = { segments: [], campaigns: [], fields: {} };
    return state.perContact[k];
  };
  const find = (list, id) => list.find((x) => String(x.id) === String(id));
  return {
    state,
    calls,
    async listSegments() { calls.push({ call: "listSegments" }); return state.instanceSegments; },
    async listCampaigns() { calls.push({ call: "listCampaigns" }); return state.instanceCampaigns; },
    async getSegment(id) { calls.push({ call: "getSegment", id: String(id) }); return find(state.instanceSegments, id) || null; },
    async updateSegment(id, fields) {
      calls.push({ call: "updateSegment", id: String(id) });
      Object.assign(find(state.instanceSegments, id), fields);
      return find(state.instanceSegments, id);
    },
    async getCampaign(id) { calls.push({ call: "getCampaign", id: String(id) }); return find(state.instanceCampaigns, id) || null; },
    async updateContact(id, fields) { calls.push({ call: "updateContact", id: String(id) }); Object.assign(of(id).fields, fields); return { id }; },
    async getContact(id) { calls.push({ call: "getContact", id: String(id) }); return { id, fields: { all: { ...of(id).fields } } }; },
    async contactSegments(id) { calls.push({ call: "contactSegments", id: String(id) }); return of(id).segments; },
    async contactCampaigns(id) { calls.push({ call: "contactCampaigns", id: String(id) }); return of(id).campaigns; },
    async removeContactFromSegment(segmentId, id) {
      calls.push({ call: "removeContactFromSegment", segmentId: String(segmentId), id: String(id) });
      of(id).segments = of(id).segments.filter((x) => String(x.id) !== String(segmentId));
      return { success: true };
    },
    async removeContactFromCampaign(campaignId, id) {
      calls.push({ call: "removeContactFromCampaign", campaignId: String(campaignId), id: String(id) });
      of(id).campaigns = of(id).campaigns.filter((x) => String(x.id) !== String(campaignId));
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
});

let seq = 0;
/* A decided receipt, optionally with its announcement already made. */
async function decidedReceipt(companyId, { withEvent = true, ref = null } = {}) {
  seq += 1;
  const handoverRef = ref || `MHO-2026-${String(4000 + seq)}`;
  /* Marketing's own record of the same handover, so a delivered announcement
     has something to be applied to.

     Created only when the reference is free: `ProspectHandover.handoverRef` is
     GLOBALLY unique, not company-scoped, which is a separate scoping question in
     a different collection and not what this suite is correcting. The
     cross-company tests below share a reference deliberately and only need the
     Sales-side records, so the second company simply goes without one. */
  const refTaken = await Handover.exists({ handoverRef });
  if (!refTaken) await Handover.create({
    companyId, handoverRef, state: "AWAITING_REVIEW",
    company: { name: "Aurora Hotels Pvt Ltd", domain: "aurorahotels.in" },
    person: { firstName: "Meera", workEmail: `r${seq}@aurorahotels.in` },
    matchKeys: { normalizedEmail: `r${seq}@aurorahotels.in` },
    assessment: { handoverReason: "Asked for a quotation.", recommendedAction: "call_within_one_business_day" },
    correlationId: `corr-${handoverRef}`, submittedAt: new Date(),
  });
  const receipt = await MarketingHandoverReceipt.create({
    companyId, handoverRef, receivedAt: new Date(), intakeOutcome: "CREATED",
    correlationId: `corr-${handoverRef}`,
    decision: "ACCEPTED", decidedAt: new Date(),
    decidedBy: { id: SELLER.id, name: SELLER.name, email: SELLER.email },
    package: { assessment: { handoverReason: "Asked for a quotation." } },
  });
  if (withEvent) await decisions.ensureOutcomeEvent(receipt);
  return receipt;
}

/* Both sides of a live handover, so a decision can be recorded properly. */
async function handoverPair(companyId, { contactId = "801", key = null } = {}) {
  seq += 1;
  const ref = `MHO-2026-${String(4000 + seq)}`;
  const gravPersonKey = key || `grav-scoping-${seq}`;
  const email = `scoping${seq}@aurorahotels.in`;
  const lead = await Lead.create({
    leadId: `LEAD-2026-${String(4000 + seq)}`, companyId, company: "Aurora Hotels Pvt Ltd",
    firstName: "Meera", captureStatus: "draft", isActive: true,
  });
  const handover = await Handover.create({
    companyId, handoverRef: ref, state: "AWAITING_REVIEW",
    company: { name: "Aurora Hotels Pvt Ltd", domain: "aurorahotels.in" },
    person: { firstName: "Meera", workEmail: email },
    matchKeys: { normalizedEmail: email, externalContactId: contactId },
    assessment: { handoverReason: "Asked for a quotation.", recommendedAction: "call_within_one_business_day" },
    correlationId: `corr-${ref}`, submittedAt: new Date(),
  });
  const receipt = await MarketingHandoverReceipt.create({
    companyId, handoverRef: ref, receivedAt: new Date(), intakeOutcome: "CREATED",
    leadId: lead._id, leadRef: lead.leadId, correlationId: `corr-${ref}`,
    package: { assessment: { handoverReason: "Asked for a quotation." } },
  });
  await MarketingIdentity.create({
    companyId, gravPersonKey, email, salesLeadId: lead._id,
    externals: [{ system: "mautic", externalId: contactId, proven: true }],
  });
  await consentService.record({
    companyId, gravPersonKey, ...consentService.MARKETING_EMAIL,
    state: "opted_in", capturedSource: "test", actor: { name: "T" },
  });
  return { ref, handover, receipt, lead, gravPersonKey, contactId };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. AN ANNOUNCEMENT BELONGS TO ONE COMPANY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("outcome-event identity is company-scoped", () => {
  test("the enforced index is (companyId, correlationId, kind)", async () => {
    const idx = await SalesMarketingOutcomeOutboxEvent.collection.indexes();
    const unique = idx.filter((i) => i.unique);
    expect(unique.map((i) => i.key)).toEqual(
      expect.arrayContaining([{ companyId: 1, correlationId: 1, kind: 1 }]),
    );
    /* And the old global constraint is not what the schema declares any more. */
    expect(unique.some((i) => JSON.stringify(i.key) === JSON.stringify({ correlationId: 1, kind: 1 })))
      .toBe(false);
  });

  test("two companies may hold the same correlation id and kind", async () => {
    const shared = "MHO-2026-4999";
    const a = await decidedReceipt(A, { ref: shared });
    const b = await decidedReceipt(B, { ref: shared });

    const events = await SalesMarketingOutcomeOutboxEvent
      .find({ correlationId: `corr-${shared}:decision` }).lean();
    expect(events).toHaveLength(2);
    expect(events.map((e) => String(e.companyId)).sort())
      .toEqual([String(A), String(B)].sort());
    expect(events.map((e) => String(e.payload.receiptId)).sort())
      .toEqual([String(a._id), String(b._id)].sort());
  });

  test("neither company reads nor suppresses the other's event", async () => {
    const shared = "MHO-2026-4998";
    /* Company A announces first. Under the global index, company B's insert was
       refused and the duplicate-key read-back then returned A's event. */
    await decidedReceipt(A, { ref: shared });
    const bReceipt = await decidedReceipt(B, { ref: shared, withEvent: false });

    const out = await decisions.ensureOutcomeEvent(bReceipt);
    expect(out.created).toBe(true);
    expect(String(out.event.companyId)).toBe(String(B));
    expect(String(out.event.payload.receiptId)).toBe(String(bReceipt._id));

    /* A second call for B returns B's own row, not A's. */
    const again = await decisions.ensureOutcomeEvent(bReceipt);
    expect(again.created).toBe(false);
    expect(String(again.event.companyId)).toBe(String(B));
  });

  test("delivering one company's event leaves the other's pending", async () => {
    const shared = "MHO-2026-4997";
    await decidedReceipt(A, { ref: shared });
    await decidedReceipt(B, { ref: shared });

    await outcomeDelivery.deliverPending({ companyId: A });

    const aEvent = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: A }).lean();
    const bEvent = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: B }).lean();
    expect(aEvent.status).toBe("DELIVERED");
    expect(bEvent.status).toBe("PENDING");
  });

  test("marking delivered is scoped, so another company's row cannot be touched by id", async () => {
    const shared = "MHO-2026-4996";
    await decidedReceipt(A, { ref: shared });
    const event = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: A }).lean();

    /* The right id, the wrong company. */
    await decisions.markOutboxDelivered(event._id, B);
    expect((await SalesMarketingOutcomeOutboxEvent.findById(event._id)).status).toBe("PENDING");

    await decisions.markOutboxDelivered(event._id, A);
    expect((await SalesMarketingOutcomeOutboxEvent.findById(event._id)).status).toBe("DELIVERED");
  });

  /* ── THE FALLBACK THAT USED TO WIDEN THE SELECTOR ──────────────────────────
     Both helpers took `companyId ? { _id: id, companyId } : { _id: id }`, so a
     caller that simply forgot the company silently updated a row by id alone —
     the one selector that can reach another company's data. It worked perfectly
     until the day an id came from the wrong place, which is the worst kind of
     bug to ship: correct in every test that passes the company, and unbounded
     in the one case nobody wrote a test for. */
  describe("neither status helper will act without a company", () => {
    let event;
    let otherEvent;

    beforeEach(async () => {
      await decidedReceipt(A, { ref: "MHO-2026-4993" });
      await decidedReceipt(B, { ref: "MHO-2026-4992" });
      event = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: A }).lean();
      otherEvent = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: B }).lean();
    });

    const statusOf = async (id) => (await SalesMarketingOutcomeOutboxEvent.findById(id)).status;
    const attemptsOf = async (id) => (await SalesMarketingOutcomeOutboxEvent.findById(id)).attempts;

    test("the right company and id delivers the event", async () => {
      await decisions.markOutboxDelivered(event._id, A);
      expect(await statusOf(event._id)).toBe("DELIVERED");
      expect(await attemptsOf(event._id)).toBe(1);
    });

    test("the right company and id records a failed attempt", async () => {
      await decisions.markOutboxAttemptFailed(event._id, new Error("Mautic did not respond."), A);
      const row = await SalesMarketingOutcomeOutboxEvent.findById(event._id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
      expect(row.lastError).toBe("Mautic did not respond.");
      expect(row.lastAttemptAt).toBeInstanceOf(Date);
    });

    test("the wrong company changes nothing, on either path", async () => {
      await decisions.markOutboxDelivered(event._id, B);
      await decisions.markOutboxAttemptFailed(event._id, new Error("nope"), B);
      const row = await SalesMarketingOutcomeOutboxEvent.findById(event._id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBe("");
      expect(row.lastAttemptAt).toBeNull();
      /* And company B's own event was not collateral damage. */
      expect(await statusOf(otherEvent._id)).toBe("PENDING");
      expect(await attemptsOf(otherEvent._id)).toBe(0);
    });

    test("a missing company refuses and writes nothing, on either path", async () => {
      for (const missing of [undefined, null, "", 0, false]) {
        await expect(decisions.markOutboxDelivered(event._id, missing))
          .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
        await expect(decisions.markOutboxAttemptFailed(event._id, new Error("x"), missing))
          .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
      }
      const row = await SalesMarketingOutcomeOutboxEvent.findById(event._id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBe("");
      /* Nothing anywhere moved: an id-only update would have found this row. */
      expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ status: "DELIVERED" })).toBe(0);
    });

    test("a missing id refuses too, rather than updating by company alone", async () => {
      await expect(decisions.markOutboxDelivered(null, A))
        .rejects.toMatchObject({ code: "VALIDATION" });
      await expect(decisions.markOutboxAttemptFailed(null, new Error("x"), A))
        .rejects.toMatchObject({ code: "VALIDATION" });
      expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ status: "DELIVERED" })).toBe(0);
    });

    test("the selector the helpers build always carries both", () => {
      expect(decisions.assertOutboxTarget(event._id, A)).toEqual({ _id: event._id, companyId: A });
      expect(() => decisions.assertOutboxTarget(event._id, null)).toThrow(/without the company/);
      expect(() => decisions.assertOutboxTarget(null, A)).toThrow(/addressed by its id/);
    });

    test("the delivery sweep still supplies both, so a real run is unaffected", async () => {
      const summary = await outcomeDelivery.deliverPending({ companyId: A });
      expect(summary.failed).toBe(0);
      expect(await statusOf(event._id)).toBe("DELIVERED");
      /* Company B's event was never touched by company A's sweep. */
      expect(await statusOf(otherEvent._id)).toBe("PENDING");
    });
  });

  test("the missing-announcement scan never crosses companies", async () => {
    const shared = "MHO-2026-4995";
    await decidedReceipt(A, { ref: shared });
    await decidedReceipt(B, { ref: shared, withEvent: false });

    /* B's receipt is missing its announcement. A's identical correlation id must
       not be read as covering it. */
    const scanB = await decisions.decidedReceiptsMissingOutcomeEvent({ companyId: B });
    expect(scanB.rows.map((r) => r.handoverRef)).toEqual([shared]);
    const scanA = await decisions.decidedReceiptsMissingOutcomeEvent({ companyId: A });
    expect(scanA.rows).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. THE SCAN BOUNDS WHAT IT FINDS, NOT WHAT IT READS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a missing announcement past the first page is still found", () => {
  test("five healthy receipts then one gap, with a page size of two", async () => {
    for (let i = 0; i < 5; i += 1) await decidedReceipt(A, { withEvent: true });
    const gap = await decidedReceipt(A, { withEvent: false });

    /* ── THE BUG THIS PINS ────────────────────────────────────────────────
       The old scan read the oldest 200 receipts and asked which of THOSE were
       missing an announcement. With a page size of two it would have read the
       first two, found them healthy, and returned nothing — for ever. */
    const scan = await decisions.decidedReceiptsMissingOutcomeEvent({
      companyId: A, limit: 10, pageSize: 2,
    });
    expect(scan.rows.map((r) => r.handoverRef)).toEqual([gap.handoverRef]);
    expect(scan.examined).toBe(6);
    expect(scan.complete).toBe(true);
    expect(scan.hasMore).toBe(false);
    expect(scan.nextCursor).toBeNull();
  });

  test("the repair fixes it, and repeating the repair is idempotent", async () => {
    for (let i = 0; i < 5; i += 1) await decidedReceipt(A, { withEvent: true });
    const gap = await decidedReceipt(A, { withEvent: false });

    const first = await decisions.repairMissingOutcomeEvents({ companyId: A, limit: 10, pageSize: 2 });
    expect(first).toMatchObject({ found: 1, repaired: 1, failed: 0, complete: true });
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(6);

    for (let i = 0; i < 3; i += 1) {
      const again = await decisions.repairMissingOutcomeEvents({ companyId: A, limit: 10, pageSize: 2 });
      expect(again).toMatchObject({ found: 0, repaired: 0, complete: true });
    }
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(6);
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({
      companyId: A, correlationId: `${gap.correlationId}:decision`,
    })).toBe(1);
  });

  test("a truncated scan says so, and reports where to resume", async () => {
    for (let i = 0; i < 6; i += 1) await decidedReceipt(A, { withEvent: false });

    /* Asking for two missing rows when six exist: found what was asked, did not
       finish looking. */
    const scan = await decisions.decidedReceiptsMissingOutcomeEvent({
      companyId: A, limit: 2, pageSize: 2,
    });
    expect(scan.rows).toHaveLength(2);
    expect(scan.complete).toBe(false);
    expect(scan.hasMore).toBe(true);
    expect(scan.nextCursor).not.toBeNull();

    /* Resuming from the cursor finds the rest rather than the same two. */
    const rest = await decisions.decidedReceiptsMissingOutcomeEvent({
      companyId: A, limit: 10, pageSize: 2, cursor: scan.nextCursor,
    });
    const seen = new Set([...scan.rows, ...rest.rows].map((r) => r.handoverRef));
    expect(seen.size).toBe(6);
    expect(rest.complete).toBe(true);
  });

  test("a scan budget stops the walk and refuses to call itself complete", async () => {
    for (let i = 0; i < 6; i += 1) await decidedReceipt(A, { withEvent: true });
    const scan = await decisions.decidedReceiptsMissingOutcomeEvent({
      companyId: A, limit: 10, pageSize: 2, scanBudget: 2,
    });
    expect(scan.rows).toEqual([]);
    expect(scan.examined).toBe(2);
    /* Nothing found, and emphatically not "nothing to find". */
    expect(scan.complete).toBe(false);
    expect(scan.nextCursor).not.toBeNull();
  });

  test("the delivery sweep reports an incomplete repair instead of a clean run", async () => {
    /* Six gaps, and the sweep is asked for one. It repairs one and has NOT
       finished looking — which is the difference between "one repaired, all
       clear" and "one repaired, five still unexamined". */
    for (let i = 0; i < 6; i += 1) await decidedReceipt(A, { withEvent: false });

    const truncated = await outcomeDelivery.deliverPending({ companyId: A, limit: 1 });
    expect(truncated.repairedOutcomeEvents).toBe(1);
    expect(truncated.repairComplete).toBe(false);
    expect(truncated.repairCursor).not.toBeNull();

    /* Sweeping until it says complete leaves nothing behind. */
    for (let i = 0; i < 8; i += 1) await outcomeDelivery.deliverPending({ companyId: A, limit: 50 });
    const full = await outcomeDelivery.deliverPending({ companyId: A, limit: 50 });
    expect(full.repairComplete).toBe(true);
    expect(full.repairCursor).toBeNull();
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: A })).toBe(6);
  });

  test("the sweep repairs a gap past the first page without anybody replaying", async () => {
    const healthy = [];
    for (let i = 0; i < 4; i += 1) healthy.push(await decidedReceipt(A, { withEvent: true }));
    const gap = await handoverPair(A, { contactId: "811" });
    const spy = jest.spyOn(SalesMarketingOutcomeOutboxEvent, "create")
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(decisions.decide({
      companyId: A, handoverRef: gap.ref, decision: "ACCEPTED", actor: SELLER,
    })).rejects.toThrow();
    spy.mockRestore();

    const summary = await outcomeDelivery.deliverPending({ companyId: A, limit: 50 });
    expect(summary.repairedOutcomeEvents).toBe(1);
    expect(summary.repairComplete).toBe(true);
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({
      companyId: A, correlationId: `corr-${gap.ref}:decision`,
    })).toBe(1);
  });

  test("another company's receipts are never examined", async () => {
    for (let i = 0; i < 4; i += 1) await decidedReceipt(B, { withEvent: false });
    const scan = await decisions.decidedReceiptsMissingOutcomeEvent({ companyId: A, pageSize: 2 });
    expect(scan.rows).toEqual([]);
    expect(scan.examined).toBe(0);
    expect(scan.complete).toBe(true);

    const repaired = await decisions.repairMissingOutcomeEvents({ companyId: A, pageSize: 2 });
    expect(repaired).toMatchObject({ found: 0, repaired: 0, complete: true });
    expect(await SalesMarketingOutcomeOutboxEvent.countDocuments({ companyId: B })).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. REGISTRATION IS NOT READY UNTIL EVERY HOLD WAS CHECKED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("registration refuses to be ready on a truncated hold scan", () => {
  /* Three applied holds. Only the third person is still sitting in the newly
     registered acquisition path, so a scan that stops after two would miss the
     only one that needed correcting. */
  async function threeHolds() {
    const contacts = ["901", "902", "903"];
    for (const [i, contactId] of contacts.entries()) {
      const pair = await handoverPair(A, { contactId });
      await Hold.create({
        companyId: A, handoverRef: pair.ref, handoverId: pair.handover._id,
        gravPersonKey: pair.gravPersonKey, mauticContactId: contactId,
        reason: "SALES_ACCEPTED", requestedAt: new Date(Date.now() + i),
        state: "APPLIED", confirmedAt: new Date(Date.now() + i), attempts: 1,
        evidence: { holdFieldSet: true, segmentsRemoved: [String(ACQ_SEGMENT)] },
      });
    }
    const client = mauticDouble({
      perContact: {
        901: { segments: [{ id: SERVICE_SEGMENT }], campaigns: [{ id: SERVICE_CAMPAIGN }], fields: { [ACQUISITION_HOLD_FIELD]: 1 } },
        902: { segments: [{ id: SERVICE_SEGMENT }], campaigns: [{ id: SERVICE_CAMPAIGN }], fields: { [ACQUISITION_HOLD_FIELD]: 1 } },
        /* The one that needs work: still in the newly registered path. */
        903: {
          segments: [{ id: NEW_ACQ_SEGMENT }, { id: SERVICE_SEGMENT }],
          campaigns: [{ id: SERVICE_CAMPAIGN }],
          fields: { [ACQUISITION_HOLD_FIELD]: 1 },
        },
      },
    });
    process.env.MAUTIC_ACQUISITION_SEGMENTS = `${ACQ_SEGMENT},${NEW_ACQ_SEGMENT}`;
    process.env.MAUTIC_ACQUISITION_CAMPAIGNS = String(ACQ_CAMPAIGN);
    return client;
  }

  test("a page size of two with three holds is NOT ready, and says where to resume", async () => {
    const client = await threeHolds();
    const report = await registration.register({
      companyId: A, client, holdPageSize: 2, maxHoldPages: 1,
    });

    expect(report.ready).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.holdsReconciled.examined).toBe(2);
    expect(report.holdsReconciled.complete).toBe(false);
    expect(report.continuation.holdCursor).not.toBeNull();
    expect(report.problems.map((p) => p.code)).toContain("ACQUISITION_HOLD_RECONCILE_INCOMPLETE");

    /* The third contact is still in the newly registered acquisition segment,
       which is exactly why the scope may not be called ready. */
    expect(client.state.perContact["903"].segments.map((x) => String(x.id)))
      .toContain(String(NEW_ACQ_SEGMENT));
  });

  test("resuming from the cursor reaches the third hold, corrects it and becomes ready", async () => {
    const client = await threeHolds();
    const first = await registration.register({
      companyId: A, client, holdPageSize: 2, maxHoldPages: 1,
    });
    expect(first.ready).toBe(false);

    const second = await registration.register({
      companyId: A, client, holdPageSize: 2, maxHoldPages: 1,
      holdCursor: first.continuation.holdCursor,
    });
    expect(second.ready).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.holdsReconciled).toMatchObject({ examined: 1, corrected: 1, failed: 0, complete: true });

    /* The third contact has left the newly registered acquisition path, and its
       service memberships survived. */
    expect(client.state.perContact["903"].segments.map((x) => String(x.id)))
      .toEqual([String(SERVICE_SEGMENT)]);
    expect(client.state.perContact["903"].campaigns.map((x) => String(x.id)))
      .toEqual([String(SERVICE_CAMPAIGN)]);
  });

  test("one run with a page size big enough examines all three and is ready", async () => {
    const client = await threeHolds();
    const report = await registration.register({ companyId: A, client, holdPageSize: 10 });
    expect(report.ready).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.holdsReconciled).toMatchObject({ examined: 3, corrected: 1, alreadyClean: 2, complete: true });
    expect(client.state.perContact["903"].segments.map((x) => String(x.id)))
      .toEqual([String(SERVICE_SEGMENT)]);
  });

  test("a page size of two and two pages allowed walks the whole set in one run", async () => {
    const client = await threeHolds();
    const report = await registration.register({
      companyId: A, client, holdPageSize: 2, maxHoldPages: 5,
    });
    expect(report.ready).toBe(true);
    expect(report.holdsReconciled.examined).toBe(3);
    expect(report.holdsReconciled.complete).toBe(true);
  });

  test("skipping the hold reconciliation can never be ready", async () => {
    const client = await threeHolds();
    const report = await registration.register({ companyId: A, client, reconcileHolds: false });
    expect(report.ready).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain("ACQUISITION_HOLD_RECONCILE_SKIPPED");
  });

  test("hold reconciliation is company-scoped and refuses without one", async () => {
    await expect(registration.reconcileAppliedHolds({ client: mauticDouble(), scope: { segments: [], campaigns: [] } }))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });

    const client = await threeHolds();
    const report = await registration.register({ companyId: B, client, holdPageSize: 10 });
    expect(report.holdsReconciled.examined).toBe(0);
    expect(report.holdsReconciled.complete).toBe(true);
    expect(client.calls.some((c) => c.call.startsWith("removeContactFrom"))).toBe(false);
  });

  test("the corrected hold keeps its original confirmation time and gets its own audit line", async () => {
    const client = await threeHolds();
    await registration.register({ companyId: A, client, holdPageSize: 10 });

    const corrected = await Hold.findOne({ companyId: A, mauticContactId: "903" }).lean();
    expect(corrected.state).toBe("APPLIED");
    expect(corrected.evidence.segmentsRemoved.sort())
      .toEqual([String(ACQ_SEGMENT), String(NEW_ACQ_SEGMENT)].sort());

    const rescoped = await MarketingAuditEvent.findOne({
      companyId: A, handoverRef: corrected.handoverRef, action: "handover.acquisition_hold.rescoped",
    }).lean();
    expect(rescoped.details.segmentsRemoved).toEqual([String(NEW_ACQ_SEGMENT)]);
  });

  test("none of this creates or moves a Sales lifecycle record", async () => {
    const client = await threeHolds();
    await registration.register({ companyId: A, client, holdPageSize: 10 });

    const leads = await Lead.find({ companyId: A }).lean();
    expect(leads).toHaveLength(3);
    for (const lead of leads) {
      expect(lead.captureStatus).toBe("draft");
      expect(lead.reviewStatus).toBe("researching");
      expect(lead.qualificationState).toBe("new");
    }
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
  });

  test("the whole chain still works: decision, company-scoped announcement, applied hold", async () => {
    const pair = await handoverPair(A, { contactId: "910" });
    const client = mauticDouble({
      perContact: {
        910: {
          segments: [{ id: ACQ_SEGMENT }, { id: SERVICE_SEGMENT }],
          campaigns: [{ id: ACQ_CAMPAIGN }, { id: SERVICE_CAMPAIGN }],
        },
      },
    });

    await decisions.decide({ companyId: A, handoverRef: pair.ref, decision: "ACCEPTED", actor: SELLER });
    const event = await SalesMarketingOutcomeOutboxEvent.findOne({ companyId: A }).lean();
    expect(String(event.companyId)).toBe(String(A));

    const salesOutcomeIntake = require("../../services/marketing/salesOutcomeIntake.service");
    await salesOutcomeIntake.receive(event, { mauticClient: client });

    const hold = await Hold.findOne({ companyId: A, handoverRef: pair.ref }).lean();
    expect(hold.state).toBe("APPLIED");
    expect(hold.evidence.segmentsRemoved).toEqual([String(ACQ_SEGMENT)]);
    expect(hold.evidence.holdFieldSet).toBe(true);
    /* The service path survived, and the timestamp came from the confirmation. */
    expect(client.state.perContact["910"].segments.map((x) => String(x.id)))
      .toEqual([String(SERVICE_SEGMENT)]);
    expect((await Handover.findById(pair.handover._id)).permission.acquisitionPausedAt)
      .toEqual(hold.confirmedAt);
    expect(await MarketingAuditEvent.countDocuments({
      companyId: A, handoverRef: pair.ref, action: "handover.accepted",
    })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE MIGRATION'S SAFETY RULE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the company-scoped index can be built on real data", () => {
  test("rows that the global index forbade are now accepted, and true duplicates are still refused", async () => {
    const shared = "MHO-2026-4994";
    await decidedReceipt(A, { ref: shared });
    await decidedReceipt(B, { ref: shared });

    /* A duplicate within ONE company is still impossible, which is what the
       migration checks for before dropping the old index. */
    const dupes = await SalesMarketingOutcomeOutboxEvent.aggregate([
      { $group: { _id: { companyId: "$companyId", correlationId: "$correlationId", kind: "$kind" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    expect(dupes).toEqual([]);

    const receipt = await MarketingHandoverReceipt.findOne({ companyId: A, handoverRef: shared }).lean();
    await expect(SalesMarketingOutcomeOutboxEvent.create({
      companyId: A,
      kind: SALES_OUTCOME_EVENT_KINDS.DECIDED,
      payload: { handoverRef: shared, receiptId: receipt._id, decision: "ACCEPTED" },
      occurredAt: new Date(),
      correlationId: `corr-${shared}:decision`,
    })).rejects.toMatchObject({ code: 11000 });
  });
});
