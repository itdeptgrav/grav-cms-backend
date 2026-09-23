// test/marketing/acquisition-hold.routes.test.js
//
// WHAT A READER IS TOLD OVER HTTP — MARKETING, SALES AND DATA HEALTH.
//
// Requirement 10 is about a sentence on a screen, so it has to be proved at the
// boundary that serves the screen. A service-level assertion would not catch a
// route that forgot to pass the field through, and that route is where the old
// behaviour did its damage: the Prospect page said acquisition was paused.
//
// Both routers are mounted in one app so the Sales view and the Marketing view
// of the SAME handover can be compared in one test, which is the only way to
// show they agree.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["sales", "admin", "ceo"];
  return mw;
});
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
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const acquisitionHold = require("../../services/marketing/acquisitionHold.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const {
  MarketingHandoverReceipt,
} = require("../../models/CMS_Models/Sales/MarketingProspectIntake");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const KEY = "grav-person-hold-http";
const EMAIL = "reader@aurorahotels.in";
const CONTACT = "707";

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "M", role: "marketing", email: "m@grav.in" };
const SELLER = { id: new mongoose.Types.ObjectId().toString(), name: "S", role: "sales", email: "s@grav.in" };
/* Driving live Mautic writes in bulk is an operator act, not an ordinary
   marketing one. */
const OPERATOR = { id: new mongoose.Types.ObjectId().toString(), name: "Ops", role: "admin", email: "ops@grav.in" };

let server;
let base;
let COMPANY;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingHandovers"));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/dataHealth"));
  app.use("/api/cms/sales/marketing-handovers", require("../../routes/CMS_Routes/Sales/marketingHandovers"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

/* No acquisition scope is registered in this suite, deliberately: these tests
   are about what a READER is told, and a hold that cannot resolve its scope
   fails without touching Mautic at all — which keeps the suite offline. Cleared
   after each test because jest reuses a worker across files. */
const SCOPE_KEYS = ["MAUTIC_ACQUISITION_SEGMENTS", "MAUTIC_ACQUISITION_CAMPAIGNS"];
const savedEnv = {};
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
  for (const k of SCOPE_KEYS) delete process.env[k];
  const c = await Acc_Company.create({ companyName: "GRAV HTTP", booksFromDate: new Date("2026-04-01") });
  COMPANY = c._id;
  await Hold.syncIndexes();
});

const call = async (path, { user = MARKETER, method = "GET", body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-test-user": JSON.stringify(user), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

let seq = 0;
async function fixture({ applied = false, failed = false } = {}) {
  seq += 1;
  const ref = `MHO-2026-${String(7700 + seq)}`;
  const handover = await Handover.create({
    companyId: COMPANY, handoverRef: ref, state: "ACCEPTED",
    company: { name: "Aurora Hotels Pvt Ltd", domain: "aurorahotels.in" },
    person: { firstName: "Meera", workEmail: EMAIL },
    matchKeys: { normalizedEmail: EMAIL, externalContactId: CONTACT },
    assessment: { handoverReason: "Asked for a quotation.", recommendedAction: "call_within_one_business_day" },
    correlationId: `corr-${ref}`, submittedAt: new Date(),
    outcome: { decision: "ACCEPTED", decidedAt: new Date() },
  });
  /* The Sales-owned receipt for the same handover, so the Sales read works. */
  await MarketingHandoverReceipt.create({
    companyId: COMPANY, handoverRef: ref, receivedAt: new Date(),
    decision: "ACCEPTED", decidedAt: new Date(),
    intakeOutcome: "CREATED",
    correlationId: `corr-${ref}`,
    package: { assessment: { handoverReason: "Asked for a quotation." } },
  });
  /* One identity and one consent record per person per company — a second
     fixture in the same test is a second HANDOVER for the same person, which is
     exactly what the per-person read needs to show. */
  if (!(await MarketingIdentity.exists({ companyId: COMPANY, gravPersonKey: KEY }))) {
    await MarketingIdentity.create({
      companyId: COMPANY, gravPersonKey: KEY, email: EMAIL,
      externals: [{ system: "mautic", externalId: CONTACT, proven: true }],
    });
    await consentService.record({
      companyId: COMPANY, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
      state: "opted_in", capturedSource: "test", actor: { name: "T" },
    });
  }
  await acquisitionHold.request({ companyId: COMPANY, handover, decision: "ACCEPTED" });

  if (applied) {
    const at = new Date();
    await Hold.updateOne({ companyId: COMPANY, handoverRef: ref }, {
      $set: {
        state: "APPLIED", confirmedAt: at, attempts: 1, lastAttemptAt: at, mauticContactId: CONTACT,
        evidence: {
          holdFieldSet: true, segmentsRemoved: ["9"], campaignsRemoved: ["4"],
          segmentsRemainingAfter: 0, campaignsRemainingAfter: 0, verifiedAt: at,
        },
      },
    });
    await Handover.updateOne({ _id: handover._id }, { $set: { "permission.acquisitionPausedAt": at } });
  }
  if (failed) {
    await Hold.updateOne({ companyId: COMPANY, handoverRef: ref }, {
      $set: {
        state: "FAILED", attempts: 1, lastAttemptAt: new Date(),
        nextAttemptAt: new Date(Date.now() + 60_000),
        activeError: {
          reasonCode: "MAUTIC_UNREACHABLE", failureClass: "TRANSIENT", sourceCode: "MAUTIC_UNAVAILABLE",
          message: "Mautic did not respond.", at: new Date(), attemptNo: 1,
        },
      },
    });
  }
  return { ref, handover };
}

describe("the Sales view never claims a pause it has not been given", () => {
  test("a pending pause reads as pending, with no pausedAt", async () => {
    const { ref } = await fixture();
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}`, { user: SELLER });
    expect(res.status).toBe(200);
    expect(res.body.marketingAcquisition.state).toBe("REQUESTED");
    expect(res.body.marketingAcquisition.pausedAt).toBeNull();
    expect(res.body.marketingAcquisition.label).toMatch(/requested/i);
    expect(res.body.marketingAcquisition.label).not.toMatch(/stopped/i);
    expect(res.body.marketingAcquisition.confirmedStopped).toBe(false);
    expect(res.body.marketingAcquisition.awaitingRetry).toBe(true);
    expect(res.body.marketingAcquisition.retryIsAutomatic).toBe(false);
  });

  test("a failed pause reads as failed, with the safe reason and no pausedAt", async () => {
    const { ref } = await fixture({ failed: true });
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}`, { user: SELLER });
    expect(res.body.marketingAcquisition.state).toBe("RETRY_WAITING");
    expect(res.body.marketingAcquisition.pausedAt).toBeNull();
    expect(res.body.marketingAcquisition.label).toMatch(/failed/i);
    /* And it does NOT promise that anything will retry on its own. */
    expect(res.body.marketingAcquisition.label).toMatch(/awaiting retry/i);
    expect(res.body.marketingAcquisition.label).not.toMatch(/automatically/i);
    expect(res.body.marketingAcquisition.retryIsAutomatic).toBe(false);
    expect(res.body.marketingAcquisition.failure.reasonCode).toBe("MARKETING_ENGINE_UNREACHABLE");
    /* A code and a sentence. No source code for the provider, no stack, no body. */
    expect(Object.keys(res.body.marketingAcquisition.failure).sort())
      .toEqual(["at", "failureClass", "message", "reasonCode"]);
  });

  test("only a confirmed pause reads as stopped, and carries the confirmation time", async () => {
    const { ref } = await fixture({ applied: true });
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}`, { user: SELLER });
    expect(res.body.marketingAcquisition.state).toBe("APPLIED");
    expect(res.body.marketingAcquisition.pausedAt).not.toBeNull();
    expect(res.body.marketingAcquisition.label).toMatch(/stopped/i);
  });

  test("the Sales view carries no Marketing internals it has no business holding", async () => {
    const { ref } = await fixture({ applied: true });
    const res = await call(`/api/cms/sales/marketing-handovers/${ref}`, { user: SELLER });
    const keys = Object.keys(res.body.marketingAcquisition).sort();
    expect(keys).toEqual([
      "awaitingRetry", "confirmedStopped", "currentlyRemoved", "failure",
      "futureEnrollmentPrevented", "label", "lastAttemptAt", "nextAttemptAt",
      "pausedAt", "requestedAt", "retryIsAutomatic", "state", "supersededBy",
    ]);
    /* No Mautic contact id, no segment or campaign ids, no person key. */
    expect(JSON.stringify(res.body.marketingAcquisition)).not.toContain(CONTACT);
    expect(JSON.stringify(res.body.marketingAcquisition)).not.toContain(KEY);
  });
});

describe("the Marketing and operator views", () => {
  test("the Marketing handover read carries the command and its evidence", async () => {
    const { ref } = await fixture({ applied: true });
    const res = await call(`/api/cms/marketing/handovers/${ref}`);
    expect(res.status).toBe(200);
    /* Chunk 3C moved this read behind the handover read model, so the hold now
       arrives on the row rather than as a sibling of the raw document, and the
       document itself is no longer served whole. The facts are the same ones. */
    expect(res.body.row.acquisition.state).toBe("APPLIED");
    expect(res.body.row.acquisition.pausedAt).not.toBeNull();
    expect(res.body.row.acquisition.disclosure.currentlyRemoved)
      .toEqual({ segments: ["9"], campaigns: ["4"] });
    expect(res.body.row.acquisition.disclosure.confirmedStopped).toBe(true);
    expect(res.body.permission.acquisitionPausedAt).not.toBeNull();
  });

  test("Marketing and Sales agree about the same handover", async () => {
    const { ref } = await fixture({ failed: true });
    const mk = await call(`/api/cms/marketing/handovers/${ref}`);
    const sl = await call(`/api/cms/sales/marketing-handovers/${ref}`, { user: SELLER });
    expect(mk.body.row.acquisition.state).toBe(sl.body.marketingAcquisition.state);
    expect(mk.body.row.acquisition.pausedAt).toBe(sl.body.marketingAcquisition.pausedAt);
    expect(mk.body.permission.acquisitionPausedAt).toBeNull();
  });

  test("Data Health counts promises and facts as separate numbers", async () => {
    await fixture({ applied: true });
    await fixture({ failed: true });
    const res = await call("/api/cms/marketing/data-health");
    expect(res.status).toBe(200);
    expect(res.body.acquisition).toMatchObject({ total: 2, applied: 1, unfinished: 1, superseded: 0 });
    expect(res.body.acquisition.oldestUnfinishedAt).not.toBeNull();
    /* The vocabulary travels with the counts so a client never hard-codes it. */
    expect(res.body.vocabulary.acquisitionHold.map((s) => s.code))
      .toEqual(["REQUESTED", "APPLIED", "FAILED", "SUPERSEDED"]);
  });

  test("the per-person Data Health read lists the commands, pausedAt only where earned", async () => {
    await fixture({ failed: true });
    await fixture({ applied: true });
    const res = await call(`/api/cms/marketing/data-health/person/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.acquisitionHolds).toHaveLength(2);
    const withPause = res.body.acquisitionHolds.filter((h) => h.pausedAt);
    expect(withPause).toHaveLength(1);
    expect(withPause[0].storedState).toBe("APPLIED");
    const failedRow = res.body.acquisitionHolds.find((h) => h.storedState === "FAILED");
    expect(failedRow.pausedAt).toBeNull();
    expect(failedRow.failureReasonCode).toBe("MARKETING_ENGINE_UNREACHABLE");
  });

  test("the operator retry seam re-drives the command and is company-scoped", async () => {
    await fixture({ failed: true });
    /* Due now, so the sweep considers it. */
    await Hold.updateMany({ companyId: COMPANY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });

    const res = await call("/api/cms/marketing/handovers/acquisition-holds/retry", {
      method: "POST", body: {}, user: OPERATOR,
    });
    expect(res.status).toBe(200);
    expect(res.body.summary.considered).toBe(1);
    /* Bounded, and it says out loud that this is not automatic recovery. */
    expect(res.body.automatic).toBe(false);
    expect(res.body.bounded.ceiling).toBe(50);
    /* No Mautic is configured in this suite, so it cannot succeed — and it says
       so rather than reporting a pause. */
    expect(res.body.summary.applied).toBe(0);
    expect(res.body.summary.stillFailed).toBe(1);

    const state = await acquisitionHold.stateFor({ companyId: COMPANY, handoverRef: (await Hold.findOne({})).handoverRef });
    expect(state.pausedAt).toBeNull();
  });

  test("a plain marketing user cannot drive the retry sweep", async () => {
    await fixture({ failed: true });
    const res = await call("/api/cms/marketing/handovers/acquisition-holds/retry", {
      method: "POST", body: {}, user: MARKETER,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/administrator/i);
  });

  test("the retry sweep is bounded however much is asked for", async () => {
    await fixture({ failed: true });
    await Hold.updateMany({ companyId: COMPANY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const res = await call("/api/cms/marketing/handovers/acquisition-holds/retry", {
      method: "POST", body: { limit: 100000 }, user: OPERATOR,
    });
    expect(res.body.bounded).toMatchObject({ requested: 100000, applied: 50, ceiling: 50 });
  });

  test("an unauthenticated caller is refused at every one of these reads", async () => {
    const { ref } = await fixture();
    for (const path of [
      `/api/cms/marketing/handovers/${ref}`,
      "/api/cms/marketing/data-health",
      `/api/cms/sales/marketing-handovers/${ref}`,
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
    }
  });
});
