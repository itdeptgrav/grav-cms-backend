// test/marketing/google-lead-reconciliation-ops.test.js
//
// CHUNK 3C.1 — THE OPERATIONAL BOUNDARY OF LEAD RECONCILIATION.
//
//   GET  /api/cms/marketing/lead-forms/recovery        any Marketing role
//   POST /api/cms/marketing/lead-forms/recovery/run    administrator only
//   the hourly scheduler                               job-registry controlled
//
// All three reach Google through ONE reconciler, for the caller's own company,
// from protected bindings only. Nothing a caller sends can name a company, an
// account, a campaign, a form or a query.
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
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingAdvertisingLead } = require("../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const { MarketingLeadDeliveryBinding } = require("../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const { MarketingLeadReconciliationLease } = require("../../models/CMS_Models/Marketing/MarketingLeadReconciliationLease");

const reconciliation = require("../../services/marketing/leads/leadReconciliation.service");
const scheduler = require("../../services/marketing/leads/leadReconciliationScheduler");
const googleAds = require("../../services/marketing/channels/googleAdsClient");
const accountBinding = require("../../services/marketing/deployment/accountBinding.service");

const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };
const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const ACCOUNT = { externalAccountId: "1234567890", loginAccountId: null };
const CAMPAIGN_ID = "9876543210123";
const FORM_ID = "5550001112223";

const GOOGLE_ENV = {
  GOOGLE_ADS_CLIENT_ID: "gid", GOOGLE_ADS_CLIENT_SECRET: "gsecret",
  GOOGLE_ADS_REFRESH_TOKEN: "grefresh", GOOGLE_ADS_CUSTOMER_ID: "1234567890",
};

let A; let B;
let server; let base;
let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/leadRecovery"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

let readSpy;
let accountSpy;
beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  /* Google and the account binding are the two things this boundary must
     never reach for real. */
  readSpy = jest.spyOn(googleAds, "readLeadFormSubmissions").mockResolvedValue({ rows: [], nextPageToken: null });
  accountSpy = jest.spyOn(accountBinding, "forDeployment").mockResolvedValue(ACCOUNT);
});
afterEach(() => jest.restoreAllMocks());

async function makeBinding(companyId, over = {}) {
  return MarketingLeadDeliveryBinding.create({
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
}

const row = (id, email = "r.sharma@acme.in") => ({
  id,
  submission_date_time: "2026-09-20 15:30:00+05:30",
  gclid: `gclid-${id}`,
  campaign_id: CAMPAIGN_ID,
  form_id: FORM_ID,
  lead_form_submission_fields: [
    { field_type: "FULL_NAME", field_value: "R Sharma" },
    { field_type: "EMAIL", field_value: email },
  ],
  custom_lead_form_submission_fields: [],
});

const call = async (method, path, { user = ADMIN, company = A, body, query = "" } = {}) => {
  const res = await fetch(`${base}${path}${query}`, {
    method,
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE STATUS READ
   ═══════════════════════════════════════════════════════════════════════════ */

describe("GET /lead-forms/recovery", () => {
  test("1. any Marketing role reads its own company's status, with every field the screen needs", async () => {
    const binding = await makeBinding(A);
    readSpy.mockResolvedValue({ rows: [row("7001")], nextPageToken: null });
    await reconciliation.reconcileCompany({ companyId: A });

    const res = await call("GET", "/lead-forms/recovery", { user: MARKETER });
    expect(res.status).toBe(200);
    expect(res.body.canRun).toBe(false);
    const r = res.body.recovery;
    expect(r).toMatchObject({ retentionDays: 60, leadsRecorded: 1, duplicatesIgnored: 0, awaitingProcessing: 0 });
    expect(new Date(r.recoverableFrom).getTime()).toBeLessThan(Date.now());
    const form = r.leadForms.find((f) => f.draftRef === binding.draftRef);
    expect(form).toMatchObject({ state: "recovery_current", recoveredEnquiries: 1, attentionReason: null });
    expect(form.checkedThrough).toBeTruthy();
    expect(form.lastCheckedAt).toBeTruthy();
    expect(res.body.vocabulary.coverageStates.map((s) => s.code)).toContain("recovery_gap");
  });

  test("2. company isolation: B's user never sees A's lead forms or counts", async () => {
    await makeBinding(A);
    readSpy.mockResolvedValue({ rows: [row("7101")], nextPageToken: null });
    await reconciliation.reconcileCompany({ companyId: A });

    const res = await call("GET", "/lead-forms/recovery", { user: MARKETER, company: B });
    expect(res.body.recovery).toMatchObject({ leadsRecorded: 0, leadForms: [] });
  });

  test("3. no contact data and no provider identifier in the status", async () => {
    const binding = await makeBinding(A);
    readSpy.mockResolvedValue({ rows: [row("7201")], nextPageToken: null });
    await reconciliation.reconcileCompany({ companyId: A });

    const flat = JSON.stringify((await call("GET", "/lead-forms/recovery", { user: MARKETER })).body);
    for (const forbidden of [
      "r.sharma@acme.in", "R Sharma", "7201", "gclid-7201", CAMPAIGN_ID, FORM_ID, ACCOUNT.externalAccountId,
      String(A), String(binding._id), binding.bindingRef,
    ]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  test("4. a query parameter naming anything is refused, not ignored", async () => {
    for (const q of [`?companyId=${B}`, `?campaignId=${CAMPAIGN_ID}`, "?query=SELECT"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call("GET", "/lead-forms/recovery", { user: MARKETER, query: q });
      expect(res.status).toBe(400);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. THE MANUAL ACTION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("POST /lead-forms/recovery/run", () => {
  test("5. administrator only", async () => {
    await makeBinding(A);
    const res = await call("POST", "/lead-forms/recovery/run", { user: MARKETER, body: {} });
    expect(res.status).toBe(403);
    expect(readSpy).not.toHaveBeenCalled();
  });

  test("6. runs THE reconciler for the caller's company, from protected bindings, and returns safe counts", async () => {
    await makeBinding(A);
    await makeBinding(B);
    const shared = jest.spyOn(reconciliation, "reconcileCompany");
    readSpy.mockResolvedValue({ rows: [row("7301"), row("7302", "b@acme.in")], nextPageToken: null });

    const res = await call("POST", "/lead-forms/recovery/run", { body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, alreadyRunning: false, leadFormsChecked: 1,
      counts: { read: 2, recorded: 2, duplicatesIgnored: 0, heldForReview: 0, unreadable: 0 },
    });
    expect(shared).toHaveBeenCalledTimes(1);
    expect(String(shared.mock.calls[0][0].companyId)).toBe(String(A));
    /* The account and campaign came from the protected records, not the call. */
    expect(accountSpy).toHaveBeenCalledWith({ companyId: A, channel: "google_ads" });
    expect(readSpy.mock.calls[0][0]).toMatchObject({ customerId: ACCOUNT.externalAccountId, campaignId: CAMPAIGN_ID, formId: FORM_ID });
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: B })).toBe(0);

    const flat = JSON.stringify(res.body);
    for (const forbidden of ["r.sharma@acme.in", "b@acme.in", "7301", CAMPAIGN_ID, FORM_ID, ACCOUNT.externalAccountId]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  test("7. accepts no company, account, campaign, form or query — refused by name", async () => {
    await makeBinding(A);
    for (const body of [
      { companyId: String(B) }, { customerId: "1111111111" }, { campaignId: CAMPAIGN_ID },
      { formId: FORM_ID }, { query: "SELECT lead_form_submission_data.id FROM lead_form_submission_data" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call("POST", "/lead-forms/recovery/run", { body });
      expect(res.status).toBe(400);
    }
    expect(readSpy).not.toHaveBeenCalled();
  });

  test("8. an already-running reconciliation is reported, not joined", async () => {
    await makeBinding(A);
    await MarketingLeadReconciliationLease.create({ companyId: A, leaseUntil: new Date(Date.now() + 5 * 60 * 1000), startedBy: "scheduler" });
    const res = await call("POST", "/lead-forms/recovery/run", { body: {} });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, alreadyRunning: true });
    expect(readSpy).not.toHaveBeenCalled();
  });

  test("9. there is no generic Google query route", async () => {
    const router = require("../../routes/CMS_Routes/Marketing/leadRecovery");
    const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expect(paths.sort()).toEqual(["GET /lead-forms/recovery", "POST /lead-forms/recovery/run"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE SCHEDULER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the reconciliation scheduler", () => {
  const enabled = async () => true;

  test("10. the job-registry switch stops it before anything is read", async () => {
    await makeBinding(A);
    const reconcile = jest.fn();
    const out = await scheduler.runCycle({ env: GOOGLE_ENV, isEnabled: async () => false, reconcile });
    expect(out.skipped).toBe("disabled");
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("11. no Google configuration: skipped safely, no company visited, nothing sent", async () => {
    await makeBinding(A);
    const reconcile = jest.fn();
    const out = await scheduler.runCycle({ env: {}, isEnabled: enabled, reconcile });
    expect(out.skipped).toBe("not_configured");
    expect(reconcile).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  test("12. an unsupported configured version: skipped, never downgraded", async () => {
    await makeBinding(A);
    const reconcile = jest.fn();
    const out = await scheduler.runCycle({ env: { ...GOOGLE_ENV, GOOGLE_ADS_API_VERSION: "v18" }, isEnabled: enabled, reconcile });
    expect(out.skipped).toBe("api_version_rejected");
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("13. companies with no active binding are never visited", async () => {
    await makeBinding(A);
    await makeBinding(B, { state: "awaiting_form_identity", providerCampaignId: "", providerFormId: "" });
    const reconcile = jest.fn().mockResolvedValue({ ran: true });
    const out = await scheduler.runCycle({ env: GOOGLE_ENV, isEnabled: enabled, reconcile });
    expect(out).toMatchObject({ companies: 1, succeeded: 1, failed: 0 });
    expect(reconcile.mock.calls.map((c) => String(c[0].companyId))).toEqual([String(A)]);
    expect(reconcile.mock.calls[0][0].startedBy).toBe("scheduler");
  });

  test("14. one company's failure does not block another, and the log carries a code only", async () => {
    await makeBinding(A);
    await makeBinding(B);
    const logged = [];
    const spy = jest.spyOn(console, "error").mockImplementation((...a) => logged.push(a.join(" ")));
    const reconcile = jest.fn(async ({ companyId }) => {
      if (String(companyId) === String(A)) {
        throw Object.assign(new Error("r.sharma@acme.in customers/1234567890 exploded"), { code: "CHANNEL_UNAVAILABLE" });
      }
      return { ran: true };
    });
    const out = await scheduler.runCycle({ env: GOOGLE_ENV, isEnabled: enabled, reconcile });
    spy.mockRestore();
    expect(out).toMatchObject({ companies: 2, succeeded: 1, failed: 1 });
    expect(logged.join("\n")).toMatch(/CHANNEL_UNAVAILABLE/);
    expect(logged.join("\n")).not.toMatch(/r\.sharma|1234567890|exploded/);
  });

  test("15. the scheduler and the manual action share one reconciler", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../../services/marketing/leads/leadReconciliationScheduler.js"), "utf8");
    expect(src).toMatch(/reconcile = reconciliation\.reconcileCompany/);
    const route = require("fs").readFileSync(require("path").join(__dirname, "../../routes/CMS_Routes/Marketing/leadRecovery.js"), "utf8");
    expect(route).toMatch(/reconciliation\.reconcileCompany\(\{ companyId, startedBy: "manual" \}\)/);
  });

  test("16. a real scheduled cycle over the one reconciler: bounded, isolated, and a run that is already going is skipped", async () => {
    await makeBinding(A);
    await makeBinding(B);
    readSpy.mockResolvedValue({ rows: [row("7601")], nextPageToken: null });
    /* B is mid-run elsewhere. */
    await MarketingLeadReconciliationLease.create({ companyId: B, leaseUntil: new Date(Date.now() + 5 * 60 * 1000), startedBy: "manual" });

    const out = await scheduler.runCycle({ env: GOOGLE_ENV, isEnabled: enabled });
    expect(out).toMatchObject({ companies: 2, failed: 0 });
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingAdvertisingLead.countDocuments({ companyId: B })).toBe(0);

    /* Two overlapping cycles in one process: the second declines. */
    const [x, y] = await Promise.all([
      scheduler.runCycle({ env: GOOGLE_ENV, isEnabled: enabled }),
      scheduler.runCycle({ env: GOOGLE_ENV, isEnabled: enabled }),
    ]);
    expect([x.skipped, y.skipped]).toContain("already_running");
  });

  test("17. the internal-processing sweep and Google reconciliation are separate jobs", () => {
    const fs = require("fs");
    const path = require("path");
    const sweep = fs.readFileSync(path.join(__dirname, "../../services/marketing/leads/leadRecovery.service.js"), "utf8");
    expect(sweep).not.toMatch(/googleAdsClient|leadReconciliation/);
    expect(scheduler.JOB_NAME).toBe("marketing-lead-reconciliation");
    const server = fs.readFileSync(path.join(__dirname, "../../server.js"), "utf8");
    expect(server).toMatch(/isEnabled\("marketing-lead-recovery"\)/);
    expect(server).toMatch(/leadReconciliationScheduler"\)\.runCycle\(\)/);
  });
});
