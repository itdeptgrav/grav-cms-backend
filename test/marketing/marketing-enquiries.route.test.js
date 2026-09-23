// test/marketing/marketing-enquiries.route.test.js
//
// THE ENQUIRIES INBOX: STATE, PRIVACY AND TENANCY, OVER THE REAL ROUTES.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   Permission is `unknown` until processing has evaluated it — not "no
//   permission recorded" while an enquiry waits, fails, retries or is held.
//   A list row carries a compact contact summary, never an address or number.
//   No provider id, database id, stage name, attempt count or secret leaves.
//   Another company's enquiry is indistinguishable from one that never existed.
//   Reading writes nothing — not a receipt, and nothing in Sales.
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

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  MarketingAdvertisingLead, MarketingAdvertisingLeadTest,
} = require("../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const { MarketingLeadProcessingReceipt } = require("../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const { MarketingLeadDeliveryBinding } = require("../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const ProspectHandover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

const processing = require("../../services/marketing/leads/leadProcessing.service");
const drafts = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const E = require("../../constants/marketingEnquiries");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const SALES = { id: new mongoose.Types.ObjectId().toString(), name: "Sal", role: "sales", email: "sal@grav.in" };

const NOTICE = Object.freeze({
  requested: true, noticeId: "marketing-optin", noticeVersion: "2026-01",
  columnId: "CATEGORY", purpose: "marketing", channel: "email",
});

let A; let B;
let server; let base;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const savedSecret = process.env.MARKETING_CHANNEL_ID_SECRET;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/enquiries"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => {
  if (savedSecret === undefined) delete process.env.MARKETING_CHANNEL_ID_SECRET;
  else process.env.MARKETING_CHANNEL_ID_SECRET = savedSecret;
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
});

/* ═══ FIXTURES ════════════════════════════════════════════════════════════ */

async function makeBinding(companyId, { notice = null, campaignDraftId = null, draftRef = null } = {}) {
  return MarketingLeadDeliveryBinding.create({
    companyId,
    bindingRef: fresh("gld"),
    campaignDraftId: campaignDraftId || new mongoose.Types.ObjectId(),
    draftRef: draftRef || fresh("MCP"),
    approvedRevision: 3,
    channel: "google_ads",
    campaignType: "google_lead_form",
    secretVersion: 1,
    state: "bound",
    idempotencyKey: fresh("idem"),
    commandFingerprint: fresh("fp"),
    consentNotice: notice || {
      requested: false, noticeId: "", noticeVersion: "", columnId: "",
      purpose: "marketing", channel: "email",
    },
  });
}

const PROVIDER_SUBMISSION = "Cj0KCQjwPROVIDERSUBMISSION";
const PROVIDER_CAMPAIGN = "20987654321";
const PROVIDER_FORM = "31234567890";
const CLICK = "EAIaIQobChMI-CLICK-ID";

async function makeLead(companyId, binding, over = {}) {
  const ref = fresh("MLS");
  const doc = await MarketingAdvertisingLead.create({
    companyId,
    submissionRef: ref,
    channel: "google_ads",
    campaignDraftId: binding.campaignDraftId,
    draftRef: binding.draftRef,
    approvedRevision: binding.approvedRevision,
    bindingId: binding._id,
    providerSubmissionId: `${PROVIDER_SUBMISSION}${seq += 1}`,
    providerCampaignId: PROVIDER_CAMPAIGN,
    providerFormId: PROVIDER_FORM,
    clickId: CLICK,
    leadSource: "LEAD_FORM",
    leadStage: "SUBMITTED",
    apiVersion: "1.0",
    submittedAt: new Date("2026-09-01T10:30:00Z"),
    receivedAt: over.receivedAt || new Date("2026-09-05T08:00:00Z"),
    contact: over.contact || {
      fullName: "R Sharma", email: "r.sharma@acme.in", phone: "+91 98765 43210", companyName: "Acme Hotels",
    },
    answers: over.answers || [],
    unmapped: over.unmapped || [],
    phoneVerified: over.phoneVerified ?? null,
    ingestionOrigin: over.ingestionOrigin || "delivery",
    classification: "production",
  });
  return { ref, id: doc._id };
}

/* A receipt exactly where a real worker could leave one mid-way. */
async function receiptAt(companyId, lead, fields) {
  return MarketingLeadProcessingReceipt.create({
    companyId, leadId: lead.id, submissionRef: lead.ref, ...fields,
  });
}

const run = (companyId, ref) => processing.process({ companyId, submissionRef: ref });

async function get(path, { user = MARKETER, company = A } = {}) {
  const headers = { "x-test-company": String(company) };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json(), text: "" };
}

async function getText(path, opts) {
  const headers = { "x-test-company": String((opts && opts.company) || A), "x-test-user": JSON.stringify(MARKETER) };
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, text: await res.text() };
}

const rowFor = (body, ref) => body.enquiries.find((e) => e.submissionRef === ref);

/* ═══ 1. STATE ════════════════════════════════════════════════════════════ */

describe("state", () => {
  test("1. an enquiry nobody has processed yet is processing, and its permission is unknown", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding);

    const { status, body } = await get("/enquiries");
    expect(status).toBe(200);
    const row = rowFor(body, lead.ref);
    expect(row.processing).toBe("processing");
    expect(row.consent).toBe("unknown");
    expect(row.consentBasis).toBeNull();
    expect(row.reviewReason).toBeNull();
    expect(row.states).toEqual(["lead_recorded", "processing_incomplete"]);
    expect(row.states).not.toContain("no_marketing_permission_recorded");
  });

  test("2. mid-way and retrying receipts stay processing/unknown, and no retry detail leaks", async () => {
    const binding = await makeBinding(A);
    const stages = [
      { stage: "pending_identity" },
      { stage: "identity_resolved", gravPersonKey: "p1", identityResolvedAt: new Date() },
      { stage: "engagement_recorded", gravPersonKey: "p2", engagementRecordedAt: new Date() },
      { stage: "retryable_failure", attempts: 7, lastAttemptAt: new Date() },
    ];
    const leads = [];
    for (const fields of stages) {
      const lead = await makeLead(A, binding);
      await receiptAt(A, lead, fields);
      leads.push(lead);
    }

    const { body, status } = await get("/enquiries");
    expect(status).toBe(200);
    for (const lead of leads) {
      const row = rowFor(body, lead.ref);
      expect(row.processing).toBe("processing");
      expect(row.consent).toBe("unknown");
      expect(row.states).not.toContain("no_marketing_permission_recorded");
    }
    const flat = JSON.stringify(body.enquiries);
    for (const internal of ["retryable_failure", "pending_identity", "identity_resolved", "attempts", "lastAttemptAt", "gravPersonKey"]) {
      expect(flat).not.toContain(internal);
    }
  });

  test("3. held for review: needs_review, with the reason, and permission still unknown", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding, { contact: { fullName: "No Way To Reach" } });
    expect((await run(A, lead.ref)).stage).toBe("needs_human_review");

    const { body } = await get("/enquiries");
    const row = rowFor(body, lead.ref);
    expect(row.processing).toBe("needs_review");
    expect(row.reviewReason).toBe("no_usable_identifier");
    expect(row.consent).toBe("unknown");
    expect(row.consentBasis).toBeNull();
  });

  test("4. a form that never asked: finished, no permission recorded, and says why", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding);
    expect((await run(A, lead.ref)).stage).toBe("completed");

    const row = rowFor((await get("/enquiries")).body, lead.ref);
    expect(row.processing).toBe("finished");
    expect(row.consent).toBe("no_permission_recorded");
    expect(row.consentBasis).toBe("consent_not_requested");
    expect(row.states).toEqual(expect.arrayContaining([
      "lead_recorded", "new_person_created", "engagement_recorded", "no_marketing_permission_recorded",
    ]));
    expect(row.states).not.toContain("processing_incomplete");
  });

  test("5. explicit agreement: permission recorded", async () => {
    const binding = await makeBinding(A, { notice: NOTICE });
    const lead = await makeLead(A, binding, {
      answers: [{ code: "CATEGORY", question: "Which category are you interested in?", answer: "Yes", selfReported: true }],
    });
    expect((await run(A, lead.ref)).reason).toBe("consent_recorded");

    const row = rowFor((await get("/enquiries")).body, lead.ref);
    expect(row.consent).toBe("permission_recorded");
    expect(row.consentBasis).toBe("consent_recorded");
  });

  test("6. a refused receipt is cannot_process with permission unknown", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding);
    await receiptAt(A, lead, { stage: "refused", reason: "submission_missing" });

    const row = rowFor((await get("/enquiries")).body, lead.ref);
    expect(row.processing).toBe("cannot_process");
    expect(row.consent).toBe("unknown");
    expect(row.reviewReason).toBeNull();
  });

  test("7. only the current contract version's receipt counts", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding);
    await receiptAt(A, lead, {
      contractVersion: 99, stage: "completed", completedAt: new Date(),
      consentEvaluatedAt: new Date(), consentRecorded: true, reason: "consent_recorded",
    });

    const row = rowFor((await get("/enquiries")).body, lead.ref);
    expect(row.processing).toBe("processing");
    expect(row.consent).toBe("unknown");
  });
});

/* ═══ 2. FILTERS AND PAGES ════════════════════════════════════════════════ */

describe("filters and pagination", () => {
  test("8. status filters agree with the row they describe, including no receipt at all", async () => {
    const binding = await makeBinding(A);
    const untouched = await makeLead(A, binding);
    const retrying = await makeLead(A, binding);
    await receiptAt(A, retrying, { stage: "retryable_failure", attempts: 3 });
    const held = await makeLead(A, binding, { contact: { fullName: "Nobody" } });
    await run(A, held.ref);
    const finished = await makeLead(A, binding);
    await run(A, finished.ref);

    const refs = async (qs) => (await get(`/enquiries?${qs}`)).body.enquiries.map((e) => e.submissionRef).sort();

    expect(await refs("consent=unknown")).toEqual([untouched.ref, retrying.ref, held.ref].sort());
    expect(await refs("consent=no_permission_recorded")).toEqual([finished.ref]);
    expect(await refs("consent=permission_recorded")).toEqual([]);
    expect(await refs("processing=processing")).toEqual([untouched.ref, retrying.ref].sort());
    expect(await refs("processing=needs_review")).toEqual([held.ref]);
    expect(await refs("processing=finished")).toEqual([finished.ref]);
    expect(await refs("processing=processing&consent=unknown")).toEqual([untouched.ref, retrying.ref].sort());

    /* Every row of every filter reports the status it was filtered by. */
    for (const code of E.CONSENT_CODES) {
      for (const row of (await get(`/enquiries?consent=${code}`)).body.enquiries) expect(row.consent).toBe(code);
    }
    for (const code of E.PROCESSING_CODES) {
      for (const row of (await get(`/enquiries?processing=${code}`)).body.enquiries) expect(row.processing).toBe(code);
    }
  });

  test("9. campaign filter by plan reference", async () => {
    const one = await makeBinding(A);
    const two = await makeBinding(A);
    const a = await makeLead(A, one);
    await makeLead(A, two);

    const { body } = await get(`/enquiries?campaign=${one.draftRef}`);
    expect(body.enquiries.map((e) => e.submissionRef)).toEqual([a.ref]);
    expect(body.filters).toEqual({ campaign: one.draftRef, processing: null, consent: null, source: null, kind: null });
  });

  test("10. pages are newest-received first, sized as asked, and totals agree", async () => {
    const binding = await makeBinding(A);
    const made = [];
    for (let i = 0; i < 5; i += 1) {
      made.push(await makeLead(A, binding, { receivedAt: new Date(Date.UTC(2026, 8, 1 + i)) }));
    }
    const newestFirst = made.map((m) => m.ref).reverse();

    const p1 = (await get("/enquiries?limit=2&page=1")).body;
    const p2 = (await get("/enquiries?limit=2&page=2")).body;
    const p3 = (await get("/enquiries?limit=2&page=3")).body;
    expect(p1.page).toEqual({ number: 1, size: 2, total: 5, pages: 3 });
    expect([...p1.enquiries, ...p2.enquiries, ...p3.enquiries].map((e) => e.submissionRef)).toEqual(newestFirst);
    expect(p3.enquiries).toHaveLength(1);
    expect((await get("/enquiries?limit=2&page=9")).body.enquiries).toEqual([]);
    expect((await get("/enquiries")).body.page.size).toBe(E.PAGE.DEFAULT);
  });

  test("11. bad input is refused, not ignored", async () => {
    for (const qs of [
      `limit=${E.PAGE.MAX + 1}`, "limit=0", "limit=two", "page=0", "page=-1",
      "processing=retryable_failure", "consent=no", "campaign=%24where",
      "companyId=abc", "sort=receivedAt", "email=x",
    ]) {
      const { status, body } = await get(`/enquiries?${qs}`);
      expect([qs, status]).toEqual([qs, 400]);
      expect(body.success).toBe(false);
    }
    expect((await get("/enquiries/MLS-x?companyId=1")).status).toBe(400);
  });
});

/* ═══ 3. DETAIL ═══════════════════════════════════════════════════════════ */

describe("detail", () => {
  test("12. what the person supplied, each answer with its question, all marked self-reported", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding, {
      contact: {
        fullName: "R Sharma", email: "r.sharma@acme.in", phone: "+91 98765 43210",
        companyName: "Acme Hotels", jobTitle: "Head of Housekeeping", city: "Pune",
      },
      answers: [{ code: "COMPANY_SIZE", question: "What size is your company?", answer: "201-500", selfReported: true }],
      unmapped: [
        { code: "CUSTOM_QUESTION", answer: "Need 400 sets", selfReported: true, needsReview: true },
        { code: "123456789012", answer: "odd column", selfReported: true, needsReview: true },
      ],
      phoneVerified: true,
      ingestionOrigin: "recovery",
    });

    const { status, body } = await get(`/enquiries/${lead.ref}`);
    expect(status).toBe(200);
    const e = body.enquiry;
    expect(e.submissionRef).toBe(lead.ref);
    expect(e.ingestionOrigin).toBe("recovery");
    expect(e.processing).toBe("processing");
    expect(e.consent).toBe("unknown");
    expect(e.contact).toEqual({ name: "R Sharma", companyName: "Acme Hotels", hasEmail: true, hasPhone: true });
    expect(e.supplied).toEqual([
      { field: "fullName", code: "FULL_NAME", label: "Full name", value: "R Sharma", provenance: "self_reported" },
      { field: "email", code: "EMAIL", label: "Email address", value: "r.sharma@acme.in", provenance: "self_reported" },
      { field: "phone", code: "PHONE_NUMBER", label: "Phone number", value: "+91 98765 43210", provenance: "self_reported" },
      { field: "city", code: "CITY", label: "City", value: "Pune", provenance: "self_reported" },
      { field: "companyName", code: "COMPANY_NAME", label: "Company name", value: "Acme Hotels", provenance: "self_reported" },
      { field: "jobTitle", code: "JOB_TITLE", label: "Job title", value: "Head of Housekeeping", provenance: "self_reported" },
    ]);
    expect(e.answers).toEqual([{
      code: "COMPANY_SIZE", question: "What size is your company?", answer: "201-500",
      selfReported: true, provenance: "self_reported",
    }]);
    expect(e.unmapped).toEqual([
      { code: "CUSTOM_QUESTION", answer: "Need 400 sets", selfReported: true, needsReview: true, provenance: "self_reported" },
      { code: "UNRECOGNISED_QUESTION", answer: "odd column", selfReported: true, needsReview: true, provenance: "self_reported" },
    ]);
    expect(e.phoneVerified).toBe(true);
    expect(e.lastProcessedAt).toBeNull();
    expect(body.vocabulary.provenance[0].code).toBe("self_reported");
  });

  test("13. phoneVerified is null when the channel said nothing", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding);
    expect((await get(`/enquiries/${lead.ref}`)).body.enquiry.phoneVerified).toBeNull();
  });

  test("14. the plan it came from, by name and signed identifier", async () => {
    const MARKETER_PLAN = {
      name: "Winter lead forms", objective: "lead_generation", channels: ["google_ads"],
      startDate: "2026-10-01", endDate: "2026-12-15", budgetAmount: 2500, budgetCurrency: "INR",
      budgetBasis: "daily", conversionGoal: "form_submission",
      utmCampaign: fresh("lf"), idempotencyKey: fresh("create-key-000"),
    };
    const plan = await drafts.create({ companyId: A, user: MARKETER, payload: MARKETER_PLAN });
    const stored = await drafts.loadForDeployment({ companyId: A, campaignDraftId: plan.campaignDraftId });
    const binding = await makeBinding(A, { campaignDraftId: stored._id, draftRef: stored.draftRef });
    const lead = await makeLead(A, binding);

    const row = rowFor((await get("/enquiries")).body, lead.ref);
    expect(row.campaign).toEqual({
      campaignDraftId: plan.campaignDraftId, draftRef: stored.draftRef, name: "Winter lead forms",
    });

    /* A plan GRAV cannot find is shown by its reference alone, with no link. */
    const orphanBinding = await makeBinding(A);
    const orphan = await makeLead(A, orphanBinding);
    expect(rowFor((await get("/enquiries")).body, orphan.ref).campaign)
      .toEqual({ campaignDraftId: null, draftRef: orphanBinding.draftRef, name: "" });
  });
});

/* ═══ 4. TENANCY ══════════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("15. another company's enquiries are never listed, and read exactly like a missing one", async () => {
    const mine = await makeLead(A, await makeBinding(A));
    const theirs = await makeLead(B, await makeBinding(B));

    const refs = (await get("/enquiries")).body.enquiries.map((e) => e.submissionRef);
    expect(refs).toEqual([mine.ref]);

    const foreign = await getText(`/enquiries/${theirs.ref}`);
    const missing = await getText("/enquiries/MLS-doesnotexist");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text).toBe(missing.text);

    /* And a receipt in B for A's lead id changes nothing in A. */
    await MarketingLeadProcessingReceipt.create({
      companyId: B, leadId: mine.id, submissionRef: mine.ref, stage: "completed",
      completedAt: new Date(), consentEvaluatedAt: new Date(), consentRecorded: true, reason: "consent_recorded",
    });
    const row = rowFor((await get("/enquiries")).body, mine.ref);
    expect(row.consent).toBe("unknown");
  });

  test("16. test deliveries are not enquiries", async () => {
    const binding = await makeBinding(A);
    await MarketingAdvertisingLeadTest.create({
      companyId: A, bindingId: binding._id, providerSubmissionId: "test-sub-1", apiVersion: "1.0",
    });
    expect((await get("/enquiries")).body.page.total).toBe(0);
  });
});

/* ═══ 5. PRIVACY ══════════════════════════════════════════════════════════ */

describe("privacy", () => {
  test("17. no provider id, database id, click id, stage, retry detail or secret, on either route", async () => {
    const binding = await makeBinding(A, { notice: NOTICE });
    const lead = await makeLead(A, binding, {
      answers: [{ code: "CATEGORY", question: "Which category are you interested in?", answer: "Yes", selfReported: true }],
    });
    await run(A, lead.ref);
    const receipt = await MarketingLeadProcessingReceipt.findOne({ companyId: A, leadId: lead.id }).lean();

    const list = await getText("/enquiries");
    const one = await getText(`/enquiries/${lead.ref}`);
    expect(list.status).toBe(200);
    expect(one.status).toBe(200);

    const forbidden = [
      PROVIDER_SUBMISSION, PROVIDER_CAMPAIGN, PROVIDER_FORM, CLICK,
      String(lead.id), String(binding._id), String(binding.campaignDraftId), String(receipt._id),
      String(A), receipt.gravPersonKey, receipt.engagementEventKey,
      binding.bindingRef, binding.idempotencyKey, binding.commandFingerprint,
      "providerSubmissionId", "providerCampaignId", "providerFormId", "bindingId", "deploymentId",
      "clickId", "leadSource", "leadStage", "apiVersion", "\"_id\"", "companyId",
      "attempts", "lastAttemptAt", "contractVersion", "google_key", "secret",
      "consent_evaluated", "retryable_failure", "pending_identity", "needs_human_review",
    ];
    for (const text of [list.text, one.text]) {
      for (const f of forbidden) expect([f, text.includes(f)]).toEqual([f, false]);
    }
  });

  test("18. a list row carries no email address or phone number; the detail does", async () => {
    const lead = await makeLead(A, await makeBinding(A), {
      contact: { fullName: "R Sharma", workEmail: "r@acme.in", workPhone: "+91 11111 22222", jobTitle: "GM" },
    });
    const list = await getText("/enquiries");
    for (const value of ["r@acme.in", "+91 11111 22222", "GM"]) expect(list.text).not.toContain(value);
    const row = rowFor(JSON.parse(list.text), lead.ref);
    expect(row.contact).toEqual({ name: "R Sharma", companyName: "", hasEmail: true, hasPhone: true });
    expect(Object.keys(row).sort()).toEqual([
      "campaign", "consent", "consentBasis", "contact", "ingestionOrigin", "kind", "processing",
      "receivedAt", "reviewReason", "source", "states", "submissionRef", "submittedAt",
    ]);
    /* A lead-form submission is a buyer enquiry from a Google lead form. */
    expect([row.source, row.kind]).toEqual(["google_lead_form", "buyer_enquiry"]);

    const one = await getText(`/enquiries/${lead.ref}`);
    expect(one.text).toContain("r@acme.in");
  });
});

/* ═══ 6. READS WRITE NOTHING ══════════════════════════════════════════════ */

describe("side effects", () => {
  test("19. reading opens no receipt, starts no processing and creates nothing in Sales", async () => {
    const binding = await makeBinding(A);
    const lead = await makeLead(A, binding);
    const processed = await makeLead(A, binding);
    await run(A, processed.ref);

    const counts = async () => ({
      receipts: await MarketingLeadProcessingReceipt.countDocuments({}),
      identities: await MarketingIdentity.countDocuments({}),
      events: await MarketingIntentEvent.countDocuments({}),
      consent: await MarketingConsent.countDocuments({}),
      handovers: await ProspectHandover.countDocuments({}),
      salesLeads: await Lead.countDocuments({}),
      salesEnquiries: await Enquiry.countDocuments({}),
    });
    const before = await counts();

    await get("/enquiries");
    await get("/enquiries?consent=unknown");
    await get(`/enquiries/${lead.ref}`);
    await get(`/enquiries/${processed.ref}`);

    expect(await counts()).toEqual(before);
    expect(before.handovers).toBe(0);
    expect(before.salesLeads).toBe(0);
    expect(before.salesEnquiries).toBe(0);
    expect(await MarketingLeadProcessingReceipt.countDocuments({ leadId: lead.id })).toBe(0);
  });

  test("20. the router declares only reads", () => {
    const router = require("../../routes/CMS_Routes/Marketing/enquiries");
    const methods = router.stack.filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`));
    expect(methods.sort()).toEqual(["get /enquiries", "get /enquiries/:submissionRef"]);
  });
});

/* ═══ 7. WHO MAY READ ═════════════════════════════════════════════════════ */

describe("authorisation", () => {
  test("21. signed out is refused; Sales is refused; Marketing reads", async () => {
    const lead = await makeLead(A, await makeBinding(A));
    expect((await get("/enquiries", { user: null })).status).toBe(401);
    expect((await get("/enquiries", { user: SALES })).status).toBe(403);
    expect((await get(`/enquiries/${lead.ref}`, { user: SALES })).status).toBe(403);
    expect((await get("/enquiries")).status).toBe(200);
  });

  test("22. the vocabulary names every code a row can carry", async () => {
    const { body } = await get("/enquiries");
    const v = body.vocabulary;
    expect(v.processing.map((x) => x.code)).toEqual(E.PROCESSING_CODES);
    expect(v.consent.map((x) => x.code)).toEqual(["unknown", "permission_recorded", "no_permission_recorded"]);
    expect(v.consentBases.map((x) => x.code)).toContain("consent_not_requested");
    expect(v.reviewReasons.map((x) => x.code).sort())
      .toEqual(["identity_conflict", "no_usable_identifier", "possible_duplicate_submission"]);
    expect(v.consent.find((x) => x.code === "unknown").means).toMatch(/not a no/i);
    /* No stage machinery in the vocabulary either. */
    expect(JSON.stringify(v)).not.toMatch(/retryable_failure|pending_identity|stages/);
  });
});
