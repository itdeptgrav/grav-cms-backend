// test/marketing/google-lead-recovery.test.js
//
// CHUNK 3C — NO ENQUIRY IS LOST BETWEEN "RECEIVED" AND "PROCESSED", AND NONE IS
// LOST BECAUSE THE WEBHOOK NEVER ARRIVED.
//
// Two gaps, two mechanisms, one pipeline:
//
//   internal  GRAV answered Google and then stopped. The receipt written with
//             the enquiry, and the sweep that finds unfinished ones.
//   external  Google never delivered. The 60-day read-back through Google's own
//             lead_form_submission_data record.
//
// And the thing that must never happen: the same submission arriving by both
// routes and becoming two engagements.
"use strict";

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  MarketingAdvertisingLead,
  MarketingAdvertisingLeadTest,
} = require("../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const { MarketingLeadProcessingReceipt } = require("../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const { MarketingLeadDeliveryBinding } = require("../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const {
  MarketingLeadReconciliationState,
} = require("../../models/CMS_Models/Marketing/MarketingLeadReconciliationState");
const {
  MarketingLeadReconciliationLease,
} = require("../../models/CMS_Models/Marketing/MarketingLeadReconciliationLease");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const ProspectHandover = require("../../models/CMS_Models/Marketing/ProspectHandover");

const { normalise } = require("../../services/marketing/leads/googleLeadNormalisation");
const ingestion = require("../../services/marketing/leads/leadIngestion.service");
const recovery = require("../../services/marketing/leads/leadRecovery.service");
const reconciliation = require("../../services/marketing/leads/leadReconciliation.service");
const P = require("../../constants/marketingLeadProcessing");
const caps = require("../../constants/marketingCampaignCapabilities");

const ROOT = path.join(__dirname, "..", "..");
const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT = { externalAccountId: "1234567890", loginAccountId: null };
const CAMPAIGN_ID = "9876543210123";
const FORM_ID = "5550001112223";

let A; let B;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const later = (ms) => new Date(Date.now() + ms);

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
});

async function makeBinding(companyId, over = {}) {
  const doc = await MarketingLeadDeliveryBinding.create({
    companyId,
    bindingRef: fresh("gld"),
    campaignDraftId: new mongoose.Types.ObjectId(),
    draftRef: fresh("MCP"),
    approvedRevision: 2,
    channel: "google_ads",
    campaignType: "google_lead_form",
    secretVersion: 1,
    state: "bound",
    providerCampaignId: CAMPAIGN_ID,
    providerFormId: FORM_ID,
    idempotencyKey: fresh("idem"),
    commandFingerprint: fresh("fp"),
    ...over,
  });
  return MarketingLeadDeliveryBinding.findById(doc._id).select("+providerCampaignId +providerFormId");
}

/* A webhook delivery, through the real normaliser. */
function webhookLead({ id, email = "r.sharma@acme.in", gclid = "gclid-abc", at = "2026-09-20T10:00:00Z", isTest = false }) {
  const out = normalise({
    via: "webhook",
    payload: {
      lead_id: id,
      user_column_data: [
        { column_id: "FULL_NAME", string_value: "R Sharma" },
        { column_id: "EMAIL", string_value: email },
      ],
      gcl_id: gclid,
      lead_submit_time: at,
      campaign_id: CAMPAIGN_ID,
      form_id: FORM_ID,
      api_version: "1.0",
      is_test: isTest,
    },
  });
  expect(out.ok).toBe(true);
  return out.lead;
}

/* One row as the client hands it back — Google's snake-case shape. */
function apiRow({ id, email = "r.sharma@acme.in", gclid = "gclid-abc", at = "2026-09-20 15:30:00+05:30" }) {
  return {
    id,
    submission_date_time: at,
    gclid,
    campaign_id: CAMPAIGN_ID,
    form_id: FORM_ID,
    lead_form_submission_fields: [
      { field_type: "FULL_NAME", field_value: "R Sharma" },
      { field_type: "EMAIL", field_value: email },
    ],
    custom_lead_form_submission_fields: [],
  };
}

/* A fake Google that serves fixed pages within ONE run, as v25 does: Google's
   own 10,000-row pages continued by `nextPageToken`. Records every question. */
function fakeGoogle(pages) {
  const calls = [];
  return {
    calls,
    async readLeadFormSubmissions(args) {
      calls.push(args);
      const idx = args.pageToken ? Number(String(args.pageToken).replace("page-", "")) : 0;
      const rows = pages[idx] || [];
      return { rows, nextPageToken: idx + 1 < pages.length ? `page-${idx + 1}` : null };
    },
  };
}

/* The ONE reconciler, as the scheduler and the manual route call it. */
const reconcile = (companyId, client, now = new Date()) => reconciliation.reconcileCompany({
  companyId, startedBy: "manual", now, client, account: ACCOUNT,
});
const stateOf = (companyId, binding) => MarketingLeadReconciliationState
  .findOne({ companyId, bindingId: binding._id }).select("+cursorId");
const formView = async (companyId, binding) => (await reconciliation.status({ companyId }))
  .leadForms.find((v) => v.draftRef === binding.draftRef);

const salesCounts = async () => {
  const Lead = require("../../models/CMS_Models/Sales/Lead");
  const Activity = require("../../models/CMS_Models/Sales/Activity");
  return Promise.all([
    ProspectHandover.countDocuments({}), Lead.countDocuments({}), Activity.countDocuments({}),
  ]);
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE DURABLE PROMISE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the promise is written with the enquiry", () => {
  test("1. ingestion writes a pending receipt before it returns, and processes nothing", async () => {
    const binding = await makeBinding(A);
    const out = await ingestion.record({ binding, lead: webhookLead({ id: "111" }) });
    expect(out.outcome).toBe("recorded");

    const receipt = await MarketingLeadProcessingReceipt.findOne({ companyId: A, submissionRef: out.submissionRef });
    expect(receipt).toBeTruthy();
    expect(receipt.stage).toBe("pending_identity");
    expect(receipt.contractVersion).toBe(P.CONTRACT_VERSION);
    /* A promise, not the work: nobody was matched, nothing was recorded. */
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(0);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(0);
  });

  test("2. a crash after acknowledgement is finished by the sweep, exactly once", async () => {
    const binding = await makeBinding(A);
    const { submissionRef } = await ingestion.record({ binding, lead: webhookLead({ id: "222" }) });
    /* …and the process dies here, before `setImmediate` ever runs. */

    /* Too soon: a live worker may still be on it. */
    const early = await recovery.sweepCompany({ companyId: A });
    expect(early.resumed).toBe(0);

    const swept = await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });
    expect(swept.resumed).toBe(1);
    expect(swept.completed).toBe(1);

    const receipt = await MarketingLeadProcessingReceipt.findOne({ companyId: A, submissionRef });
    expect(receipt.stage).toBe("completed");
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);

    /* Running it again finds nothing owed and changes nothing. */
    const again = await recovery.sweepCompany({ companyId: A, now: later(20 * 60 * 1000) });
    expect(again).toMatchObject({ resumed: 0, promised: 0, completed: 0 });
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
  });

  test("3. an enquiry whose promise was never written is found and processed", async () => {
    const binding = await makeBinding(A);
    /* Stored directly — the receipt write failed. */
    const lead = await MarketingAdvertisingLead.create({
      companyId: A, submissionRef: fresh("MLS"), channel: "google_ads",
      campaignDraftId: binding.campaignDraftId, draftRef: binding.draftRef,
      approvedRevision: binding.approvedRevision, bindingId: binding._id,
      providerSubmissionId: "333", submittedAt: new Date(), receivedAt: new Date(),
      contact: { fullName: "N Orphan", email: "orphan@acme.in" },
      ingestionOrigin: "delivery", classification: "production",
    });
    expect(await MarketingLeadProcessingReceipt.countDocuments({ companyId: A })).toBe(0);

    const swept = await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });
    expect(swept.promised).toBe(1);
    expect(swept.completed).toBe(1);

    const receipt = await MarketingLeadProcessingReceipt.findOne({ companyId: A, leadId: lead._id });
    expect(receipt.stage).toBe("completed");
  });

  test("4. held and exhausted receipts are not retried by the sweep", async () => {
    const binding = await makeBinding(A);
    const held = await ingestion.record({ binding, lead: webhookLead({ id: "401" }) });
    await MarketingLeadProcessingReceipt.updateOne(
      { companyId: A, submissionRef: held.submissionRef },
      { $set: { stage: "needs_human_review", reason: "possible_duplicate_submission" } },
    );
    const stuck = await ingestion.record({ binding, lead: webhookLead({ id: "402", email: "other@acme.in", gclid: "g2" }) });
    await MarketingLeadProcessingReceipt.updateOne(
      { companyId: A, submissionRef: stuck.submissionRef },
      { $set: { stage: "retryable_failure", attempts: P.RECOVERY.MAX_ATTEMPTS } },
    );

    const swept = await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });
    expect(swept.resumed).toBe(0);
    expect(swept.exhausted).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(0);
  });

  test("5. a sweep of one company never touches another's enquiries", async () => {
    const inA = await makeBinding(A);
    const inB = await makeBinding(B);
    /* The same Google id in both companies is two enquiries. */
    const a = await ingestion.record({ binding: inA, lead: webhookLead({ id: "555" }) });
    const b = await ingestion.record({ binding: inB, lead: webhookLead({ id: "555" }) });
    expect(a.outcome).toBe("recorded");
    expect(b.outcome).toBe("recorded");

    await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });
    expect((await MarketingLeadProcessingReceipt.findOne({ companyId: A })).stage).toBe("completed");
    expect((await MarketingLeadProcessingReceipt.findOne({ companyId: B })).stage).toBe("pending_identity");

    const all = await recovery.sweepAll({ now: later(10 * 60 * 1000) });
    expect(all.companies).toBe(2);
    expect((await MarketingLeadProcessingReceipt.findOne({ companyId: B })).stage).toBe("completed");
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIdentity.countDocuments({ companyId: B })).toBe(1);
  });

  test("6. a test delivery leaves nothing for any sweep to find", async () => {
    const binding = await makeBinding(A);
    const out = await ingestion.record({ binding, lead: webhookLead({ id: "666", isTest: true }) });
    expect(out.outcome).toBe("test_recorded");

    expect(await MarketingAdvertisingLeadTest.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(0);
    expect(await MarketingLeadProcessingReceipt.countDocuments({ companyId: A })).toBe(0);
    const swept = await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });
    expect(swept).toMatchObject({ resumed: 0, promised: 0 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. THE 60-DAY READ-BACK
   ═══════════════════════════════════════════════════════════════════════════ */

describe("reconciliation against Google's record", () => {
  test("7. a lead the webhook never delivered is brought in and processed through the same pipeline", async () => {
    const binding = await makeBinding(A);
    const google = fakeGoogle([[apiRow({ id: "701" })]]);

    const out = await reconcile(A, google);
    expect(out.ran).toBe(true);
    expect(out.counts.recorded).toBe(1);
    const view = await formView(A, binding);
    expect(view.state).toBe("recovery_current");
    expect(view.recoveredEnquiries).toBe(1);

    const lead = await MarketingAdvertisingLead.findOne({ companyId: A });
    expect(lead.ingestionOrigin).toBe("recovery");
    expect(lead.contact.email).toBe("r.sharma@acme.in");
    /* The API's zoned time is the same instant the webhook would have sent. */
    expect(lead.submittedAt.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect((await MarketingLeadProcessingReceipt.findOne({ companyId: A })).stage).toBe("completed");
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);

    /* Asked about exactly this campaign and form, in the account GRAV is bound
       to, in whole days, with no page size (v25 refuses one). */
    expect(google.calls[0]).toMatchObject({
      customerId: ACCOUNT.externalAccountId, campaignId: CAMPAIGN_ID, formId: FORM_ID, pageToken: null,
    });
    expect(google.calls[0]).not.toHaveProperty("pageSize");
    expect(google.calls[0].fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(google.calls[0].toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("8. webhook first, API later: one enquiry, one set of effects", async () => {
    const binding = await makeBinding(A);
    const { submissionRef } = await ingestion.record({ binding, lead: webhookLead({ id: "801" }) });
    await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });

    const out = await reconcile(A, fakeGoogle([[apiRow({ id: "801" })]]));
    expect(out.counts).toMatchObject({ recorded: 0, alreadyHeld: 1 });

    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingLeadProcessingReceipt.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
    expect((await MarketingAdvertisingLead.findOne({ companyId: A })).submissionRef).toBe(submissionRef);
    expect((await formView(A, binding)).duplicatesIgnored).toBe(1);
  });

  test("9. API first, webhook later: the delivery is a duplicate and adds nothing", async () => {
    const binding = await makeBinding(A);
    await reconcile(A, fakeGoogle([[apiRow({ id: "901" })]]));

    const late = await ingestion.record({ binding, lead: webhookLead({ id: "901" }) });
    expect(late.outcome).toBe("duplicate");
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
  });

  test("10. different ids, same click, same moment: the second is kept and held, never processed", async () => {
    const binding = await makeBinding(A);
    await ingestion.record({ binding, lead: webhookLead({ id: "1001" }) });
    await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });

    const out = await reconcile(A, fakeGoogle([[apiRow({ id: "1002", at: "2026-09-20 15:31:00+05:30" })]]));
    expect(out.counts).toMatchObject({ recorded: 0, heldForReview: 1 });

    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(2);
    const held = await MarketingLeadProcessingReceipt.findOne({ companyId: A, stage: "needs_human_review" });
    expect(held.reason).toBe("possible_duplicate_submission");
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIdentity.countDocuments({ companyId: A })).toBe(1);

    const swept = await recovery.sweepCompany({ companyId: A, now: later(30 * 60 * 1000) });
    expect(swept.resumed).toBe(0);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
    expect((await reconciliation.status({ companyId: A })).heldForReview).toBe(1);
  });

  test("11. two webhook deliveries with different ids are two leads — the hold is only across routes", async () => {
    const binding = await makeBinding(A);
    await ingestion.record({ binding, lead: webhookLead({ id: "1101" }) });
    await ingestion.record({ binding, lead: webhookLead({ id: "1102" }) });
    expect(await MarketingLeadProcessingReceipt.countDocuments({ companyId: A, stage: "needs_human_review" })).toBe(0);
  });

  test("12. Google's pages are followed within a run, bounded, and the (time, id) cursor carries the next run", async () => {
    const binding = await makeBinding(A);
    const pageCount = P.RECOVERY.MAX_PAGES_PER_RUN + 1;
    /* One row per page. The last two share a second, so the id breaks the tie —
       and the larger id is SHORTER as text, which a string compare gets wrong. */
    const pages = Array.from({ length: pageCount }, (_, i) => [apiRow({
      id: String(1200 + i), email: `p${i}@acme.in`, gclid: `g${i}`,
      at: `2026-09-${String(10 + i).padStart(2, "0")} 10:00:00+00:00`,
    })]);
    pages[pageCount - 2] = [apiRow({ id: "100000", email: "tie@acme.in", gclid: "gtie", at: "2026-09-19 10:00:00+00:00" })];
    pages[pageCount - 1] = [apiRow({ id: "99", email: "last@acme.in", gclid: "glast", at: "2026-09-19 10:00:00+00:00" })];

    const google = fakeGoogle(pages);
    const first = await reconcile(A, google);
    /* Bounded: never more pages than the limit in one run. */
    expect(google.calls).toHaveLength(P.RECOVERY.MAX_PAGES_PER_RUN);
    expect(google.calls.slice(1).map((c) => c.pageToken)).toEqual(
      Array.from({ length: P.RECOVERY.MAX_PAGES_PER_RUN - 1 }, (_, i) => `page-${i + 1}`),
    );
    expect(first.counts.recorded).toBe(P.RECOVERY.MAX_PAGES_PER_RUN);
    let state = await stateOf(A, binding);
    expect(state.lastStatus).toBe("partial");
    expect(state.attentionReason).toBe("backlog");
    expect((await formView(A, binding)).state).toBe("recovery_behind");
    /* The cursor is the last row PROCESSED, with the id breaking the tie. */
    expect(state.cursorAt.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    expect(state.cursorId).toBe("100000");

    /* Nothing Google-owned is carried between runs: the next run starts a
       fresh query from the cursor, a day of overlap earlier, and finishes. */
    const next = fakeGoogle([pages[pageCount - 2].concat(pages[pageCount - 1])]);
    const second = await reconcile(A, next, later(60 * 1000));
    expect(next.calls[0].pageToken).toBeNull();
    /* The window reaches back over the cursor's own day, so the tied row that
       was not yet processed is read again. (The start is the later of the
       cursor and the binding's creation — nothing can be submitted before a
       binding exists — less the overlap and a day of timezone slack.) */
    expect(Date.parse(next.calls[0].fromDate)).toBeLessThanOrEqual(Date.parse("2026-09-19"));
    expect(second.counts).toMatchObject({ recorded: 1, alreadyHeld: 1 });
    state = await stateOf(A, binding);
    expect(state.lastStatus).toBe("ok");
    expect(state.cursorId).toBe("100000");
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(pageCount);
  });

  test("13. a run stops after a bounded number of NEW enquiries, mid-page, and resumes after them", async () => {
    const binding = await makeBinding(A);
    const n = P.RECOVERY.MAX_NEW_ROWS_PER_RUN + 3;
    const rows = Array.from({ length: n }, (_, i) => apiRow({
      id: String(5000 + i), email: `bulk${i}@acme.in`, gclid: `gb${i}`,
      at: `2026-09-15 ${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+00:00`,
    }));
    const out = await reconcile(A, fakeGoogle([rows]));
    expect(out.counts.recorded).toBe(P.RECOVERY.MAX_NEW_ROWS_PER_RUN);
    expect((await stateOf(A, binding)).lastStatus).toBe("partial");

    const again = await reconcile(A, fakeGoogle([rows]), later(60 * 1000));
    expect(again.counts).toMatchObject({ recorded: 3, alreadyHeld: P.RECOVERY.MAX_NEW_ROWS_PER_RUN });
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(n);
  }, 120000);

  test("14. the overlap re-reads what was already read, and one lookup absorbs all of it", async () => {
    const binding = await makeBinding(A);
    const rows = [apiRow({ id: "1301" }), apiRow({ id: "1302", email: "b@acme.in", gclid: "gb" })];
    await reconcile(A, fakeGoogle([rows]));

    const google = fakeGoogle([rows]);
    const out = await reconcile(A, google, later(2 * 60 * 60 * 1000));
    expect(out.counts).toMatchObject({ recorded: 0, alreadyHeld: 2 });
    /* The second window starts at least a day before where the first was sure. */
    expect(Date.parse(google.calls[0].fromDate)).toBeLessThanOrEqual(Date.now() - P.RECOVERY.OVERLAP_MS);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(2);
    expect((await formView(A, binding)).duplicatesIgnored).toBe(2);
  });

  test("15. never further back than Google keeps leads, and the gap is disclosed", async () => {
    const binding = await makeBinding(A);
    const now = later(75 * DAY);
    const google = fakeGoogle([[]]);

    await reconcile(A, google, now);
    const status = await reconciliation.status({ companyId: A, now });
    const view = status.leadForms.find((v) => v.draftRef === binding.draftRef);
    expect(view.state).toBe("recovery_gap");
    expect(view.unrecoverableBefore).toBeTruthy();
    expect(status.retentionDays).toBe(60);
    expect(status.recoverableFrom.getTime()).toBe(now.getTime() - 60 * DAY);

    const retentionStart = now.getTime() - 60 * DAY;
    /* One day of slack for the account's own timezone, and no more. */
    expect(Date.parse(google.calls[0].fromDate)).toBeGreaterThanOrEqual(retentionStart - 2 * DAY);
    expect(Date.parse(google.calls[0].toDate)).toBeGreaterThanOrEqual(now.getTime());

    await reconcile(A, fakeGoogle([[]]), new Date(now.getTime() + DAY));
    expect((await reconciliation.status({ companyId: A, now: new Date(now.getTime() + DAY) }))
      .leadForms[0].state).toBe("recovery_gap");
    const muchLater = new Date(now.getTime() + 61 * DAY);
    await reconcile(A, fakeGoogle([[]]), muchLater);
    expect((await reconciliation.status({ companyId: A, now: muchLater })).leadForms[0].state).toBe("recovery_current");
  });

  test("16. a quiet campaign is not a gap: coverage, not the cursor, decides", async () => {
    await makeBinding(A);
    await reconcile(A, fakeGoogle([[apiRow({ id: "1501" })]]));
    for (let d = 1; d <= 50; d += 10) {
      await reconcile(A, fakeGoogle([[]]), new Date(Date.now() + d * DAY));
    }
    const at = new Date(Date.now() + 65 * DAY);
    await reconcile(A, fakeGoogle([[]]), at);
    expect((await reconciliation.status({ companyId: A, now: at })).leadForms[0].state).toBe("recovery_current");
  });

  test("17. an access failure says which one, reveals nothing, and stops asking for the rest", async () => {
    const first = await makeBinding(A);
    const second = await makeBinding(A);
    const errors = [];
    const spy = jest.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));
    const calls = [];
    const failing = {
      async readLeadFormSubmissions(args) {
        calls.push(args);
        throw Object.assign(new Error(`customers/${ACCOUNT.externalAccountId}/campaigns/${CAMPAIGN_ID} PROJECT_DISABLED`), { code: "CHANNEL_API_ACCESS_UNAVAILABLE" });
      },
    };
    const out = await reconcile(A, failing);
    spy.mockRestore();

    /* The same account refuses every binding the same way: asked once. */
    expect(calls).toHaveLength(1);
    const status = await reconciliation.status({ companyId: A });
    for (const b of [first, second]) {
      const v = status.leadForms.find((x) => x.draftRef === b.draftRef);
      expect(v.state).toBe("recovery_unavailable");
      expect(v.attentionReason.code).toBe("api_access_unavailable");
    }
    const flat = JSON.stringify(out);
    expect(flat).not.toMatch(new RegExp(`${CAMPAIGN_ID}|${ACCOUNT.externalAccountId}|PROJECT_DISABLED`));
    expect(errors.join("\n")).not.toMatch(new RegExp(`${CAMPAIGN_ID}|${ACCOUNT.externalAccountId}|r\\.sharma`));
    expect((await MarketingLeadReconciliationLease.findOne({ companyId: A })).leaseUntil).toBeNull();
  });

  test("18. a company with no active binding is never asked about, and a draft one says why", async () => {
    const draft = await makeBinding(A, { state: "awaiting_form_identity", providerCampaignId: "", providerFormId: "" });
    const google = fakeGoogle([[apiRow({ id: "1701" })]]);
    const out = await reconcile(A, google);
    expect(out.bindings).toBe(0);
    expect(google.calls).toHaveLength(0);
    const view = await formView(A, draft);
    expect(view.state).toBe("recovery_unavailable");
    expect(view.attentionReason.code).toBe("campaign_not_created");
  });

  test("19. one run per company: a second caller is told it is already running", async () => {
    await makeBinding(A);
    await MarketingLeadReconciliationLease.create({ companyId: A, leaseUntil: later(5 * 60 * 1000), startedBy: "scheduler" });
    const google = fakeGoogle([[apiRow({ id: "1801" })]]);
    const out = await reconcile(A, google);
    expect(out).toMatchObject({ ran: false, busy: true });
    expect(google.calls).toHaveLength(0);

    /* A lease that outlived its run is presumed dead, not held for ever. */
    const after = await reconcile(A, google, later(11 * 60 * 1000));
    expect(after.ran).toBe(true);
  });

  test("20. reconciling one company never reads or writes another's", async () => {
    const theirs = await makeBinding(B);
    const google = fakeGoogle([[apiRow({ id: "1901" })]]);
    const out = await reconcile(A, google);
    expect(out.bindings).toBe(0);
    expect(google.calls).toHaveLength(0);
    expect(await MarketingAdvertisingLead.countDocuments({})).toBe(0);
    expect(await MarketingLeadReconciliationState.countDocuments({ bindingId: theirs._id })).toBe(0);
  });

  test("21. the same Google id in two companies is two enquiries, each in its own company", async () => {
    await makeBinding(A);
    await makeBinding(B);
    await reconcile(A, fakeGoogle([[apiRow({ id: "2001" })]]));
    await reconcile(B, fakeGoogle([[apiRow({ id: "2001" })]]));
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: B })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingIntentEvent.countDocuments({ companyId: B })).toBe(1);
  });

  test("22. a row naming a different form is not this binding's enquiry", async () => {
    const binding = await makeBinding(A);
    const stray = { ...apiRow({ id: "2101" }), form_id: "1111111111" };
    await reconcile(A, fakeGoogle([[stray]]));
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(0);
    expect((await stateOf(A, binding)).lastRun.unreadable).toBe(1);
  });

  test("23. status lists every lead form in the company, in public words only", async () => {
    const bound = await makeBinding(A);
    await makeBinding(A, { state: "prepared", providerCampaignId: "", providerFormId: "" });
    await makeBinding(B);
    await reconcile(A, fakeGoogle([[apiRow({ id: "2201" })]]));

    const status = await reconciliation.status({ companyId: A });
    expect(status.leadForms).toHaveLength(2);
    expect(status.leadForms.map((v) => v.state).sort()).toEqual(["recovery_current", "recovery_unavailable"]);
    for (const v of status.leadForms) expect(P.COVERAGE_STATE_CODES).toContain(v.state);
    expect(status).toMatchObject({ leadsRecorded: 1, awaitingProcessing: 0 });
    expect(status.leadForms.find((v) => v.draftRef === bound.draftRef).checkedThrough).toBeTruthy();

    const flat = JSON.stringify(status);
    const bindings = await MarketingLeadDeliveryBinding.find({ companyId: A });
    for (const forbidden of [
      CAMPAIGN_ID, FORM_ID, ACCOUNT.externalAccountId, "2201", "gclid-abc", "r.sharma@acme.in", "R Sharma",
      String(A), ...bindings.map((b) => String(b._id)), ...bindings.map((b) => b.bindingRef),
    ]) {
      expect(flat).not.toContain(forbidden);
    }
    expect(flat).not.toMatch(/pageToken|cursor/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. BOUNDARIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what 3C does not do", () => {
  test("24. recovery and reconciliation never reach Sales, and never write to Google", async () => {
    const before = await salesCounts();
    const binding = await makeBinding(A);
    await ingestion.record({ binding, lead: webhookLead({ id: "2501" }) });
    await recovery.sweepCompany({ companyId: A, now: later(10 * 60 * 1000) });
    await reconcile(A, fakeGoogle([[apiRow({ id: "2502", email: "x@acme.in", gclid: "gx" })]]));
    expect(await salesCounts()).toEqual(before);

    for (const f of [
      "services/marketing/leads/leadRecovery.service.js",
      "services/marketing/leads/leadReconciliation.service.js",
      "services/marketing/leads/leadReconciliationScheduler.js",
      "services/marketing/leads/leadProcessingQueue.js",
      "routes/CMS_Routes/Marketing/leadRecovery.js",
    ]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src).not.toMatch(/require\(["'].*(Sales\/|\/Lead["']|\/Enquiry|\/Activity|prospectHandover|handover)/i);
      /* Reads only: no creation or mutation client is imported. */
      expect(src).not.toMatch(/googleSearchBundle|metaAdsWriteClient|createPaused|mutate/i);
    }
  });

  test("25. the reconciliation state stores no person and no secret", async () => {
    await makeBinding(A);
    await reconcile(A, fakeGoogle([[apiRow({ id: "2601" })]]));
    const raw = await MarketingLeadReconciliationState.collection.findOne({ companyId: A });
    expect(JSON.stringify(raw)).not.toMatch(/r\.sharma@acme\.in|R Sharma|gclid-abc|google_key|FULL_NAME|pageToken/);
  });

  test("26. lead forms stay undeployable; the missing piece is creation, the prerequisite is named; Meta stays unavailable", () => {
    const type = caps.CAMPAIGN_TYPE_BY_CODE.google_lead_form;
    expect(type.deployable).toBe(false);
    expect(caps.DEPLOYABLE_CAMPAIGN_TYPES).not.toContain("google_lead_form");
    /* Creation into the proof account now exists; the boundary is the proof. */
    expect(type.blockedBy).toMatch(/not yet been proven on a real account/i);
    expect(type.needs[0]).toMatch(/created, stopped, in the proof account/i);
    /* API access is not hidden behind "creation not built". */
    expect(type.needs.join(" ")).toMatch(/Google Cloud project/i);
    expect(caps.CAMPAIGN_TYPE_BY_CODE.meta_lead_form.deployable).toBe(false);
  });
});
