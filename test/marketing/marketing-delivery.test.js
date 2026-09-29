// test/marketing/marketing-delivery.test.js
//
// DURABLE DELIVERY STATE, CONCURRENCY-SAFE RETRY, READ-ONLY RECONCILIATION,
// AND THE DATA HEALTH API.
//
// The production sync path is exercised throughout — only the transport is the
// contract double — so what these tests prove is the real instrumentation, the
// real classification, the real backoff and the real claim, not a model of them.
//
// The negative cases are the point of the suite. A delivery-state model that
// records successes is easy; the value is in what it records when Mautic never
// answered, and in proving that two workers cannot both act on the same row.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

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
  return mw;
});

const { MauticClient } = require("../../services/marketing/mauticClient");
const { createMauticDouble } = require("../../services/marketing/mauticTestDouble");
const sync = require("../../services/marketing/mauticContactSync.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const deliveryService = require("../../services/marketing/marketingDelivery.service");
const reconciliation = require("../../services/marketing/marketingReconciliation.service");
const DeliveryState = require("../../models/CMS_Models/Marketing/MarketingDeliveryState");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingConsent } = require("../../models/CMS_Models/Marketing/MarketingConsent");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { DELIVERY_RETRY } = require("../../constants/marketing");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");

const ENV = {
  MAUTIC_BASE_URL: "http://localhost:8088",
  MAUTIC_AUTH_MODE: "basic",
  MAUTIC_BASIC_USERNAME: "u",
  MAUTIC_BASIC_PASSWORD: "correct-horse-battery-staple",
  MAUTIC_HTTP_RETRIES: "0",
};

const KEY = "grav-person-delivery-1";
const PERSON = {
  firstName: "Meera", lastName: "Sharma", jobTitle: "Head of Procurement",
  workEmail: "meera@aurorahotels.in", companyName: "Aurora Hotels Pvt Ltd",
};
const ACTOR = { id: new mongoose.Types.ObjectId(), name: "Nikhil Bose" };

let COMPANY;
let OTHER_COMPANY;

/** The production client with the contract double behind it. `failWith` makes a
 *  deterministic, safe failure — no network, no real Mautic. */
function clientWith(opts = {}) {
  const double = createMauticDouble(opts);
  return { client: new MauticClient({ env: ENV, transport: { request: double.request } }), double };
}

const grant = (key = KEY, companyId = null) => consentService.record({
  companyId: companyId || COMPANY,
  gravPersonKey: key,
  ...consentService.MARKETING_EMAIL,
  state: "opted_in",
  capturedSource: "test: landing page form",
  noticeVersion: "v3",
  actor: ACTOR,
});

/** An identity row, which the retry runner needs to find contact details. */
const identity = (key = KEY, email = PERSON.workEmail, companyId = null) =>
  MarketingIdentity.create({ companyId: companyId || COMPANY, gravPersonKey: key, email });

const stateOf = (key = KEY, companyId = null) =>
  deliveryService.stateFor({ companyId: companyId || COMPANY, gravPersonKey: key });

/* ── THE DATA HEALTH APP ─────────────────────────────────────────────────── */
let server;
let base;
const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Nikhil Bose", role: "marketing", email: "nikhil@grav.in" };
const OUTSIDER = { id: new mongoose.Types.ObjectId().toString(), name: "Ravi", role: "store", email: "ravi@grav.in" };

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/dataHealth"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  /* One company in the master and no membership rows, so the shared resolver's
     single-company-deployment path gives the signed-in marketer this company —
     the same path the handover suite uses. */
  const co = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  COMPANY = co._id;
  OTHER_COMPANY = new mongoose.Types.ObjectId();
});

async function call(path, { user = MARKETER } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
  });
  return { status: res.status, body: await res.json() };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. A FAILURE BEFORE A CONTACT ID EXISTS IS STILL QUERYABLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Failures that never reach Mautic are durable", () => {
  test("an unreachable Mautic leaves a queryable row with no contact id", async () => {
    await grant();
    const { client, double } = clientWith({ failWith: { code: "ECONNREFUSED" } });

    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }))
      .rejects.toMatchObject({ code: "MAUTIC_UNAVAILABLE" });

    /* THE GAP THIS MODEL CLOSES, AND THE CORRECTION TO IT.
       No Mautic contact exists and no external mapping is claimed — but the
       IDENTITY does exist, written before the remote call. The first version
       asserted zero identities, which is what made the failure invisible:
       reconciliation walks identities, so a person with none could not appear in
       Data Health and could not be found by the retry runner. */
    expect(double.state.contacts.size).toBe(0);
    const idRow = await MarketingIdentity.findOne({ gravPersonKey: KEY }).lean();
    expect(idRow).toBeTruthy();
    expect(idRow.email).toBe(PERSON.workEmail);
    /* No link is claimed to a contact that does not exist. */
    expect((idRow.externals || []).filter((e) => e.system === "mautic")).toHaveLength(0);

    const s = await stateOf();
    expect(s.exists).toBe(true);
    expect(s.health).toBe("RETRY_SCHEDULED");
    expect(s.effectiveHealth).toBe("RETRY_WAITING");
    expect(s.reasonCode).toBe("MAUTIC_UNREACHABLE");
    expect(s.mauticContactId).toBe("");
    expect(s.attempts).toBe(1);
    expect(s.lastAttemptAt).toBeInstanceOf(Date);
    expect(s.lastSuccessfulSyncAt).toBeNull();
  });

  test("the attempt is opened before the remote call, so a crash cannot read as success", async () => {
    await grant();
    /* A transport that throws a non-Error after the attempt was opened. The row
       must show an attempt and must NOT show success. */
    const client = new MauticClient({
      env: ENV,
      transport: { request: async () => { throw Object.assign(new Error("boom"), { code: "ECONNRESET" }); } },
    });
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();

    const s = await stateOf();
    expect(s.attempts).toBe(1);
    expect(s.lastSuccessfulSyncAt).toBeNull();
    expect(s.row.lastOutcome).toBe("FAILURE");
    expect(s.row.inFlightSince).toBeNull();
  });

  test("no credentials, provider body or stack reaches delivery state", async () => {
    await grant();
    const { client } = clientWith({ failWith: { status: 503 } });
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();

    const row = await DeliveryState.findOne({}).lean();
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(ENV.MAUTIC_BASIC_PASSWORD);
    expect(serialised).not.toContain("simulated");      // the double's error body
    expect(serialised).not.toContain("at Object.");      // a stack frame
    /* And no personal data: the identity row holds the address. */
    expect(serialised).not.toContain("meera");
    expect(row.activeError.message.length).toBeLessThanOrEqual(500);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2-3. BACKOFF, AND NOT FOR EVER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Retry is bounded and deterministic", () => {
  test("a transient failure schedules a retry with bounded backoff", async () => {
    await grant();
    const { client } = clientWith({ failWith: { code: "ETIMEDOUT" } });
    const t0 = Date.now();
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();

    const s = await stateOf();
    expect(s.health).toBe("RETRY_SCHEDULED");
    expect(s.row.retryCount).toBe(1);
    const delay = s.nextAttemptAt.getTime() - t0;
    expect(delay).toBeGreaterThanOrEqual(DELIVERY_RETRY.BASE_MS - 2000);
    expect(delay).toBeLessThanOrEqual(DELIVERY_RETRY.BASE_MS + 5000);
  });

  test("backoff doubles and is capped", () => {
    expect(deliveryService.backoffMsFor(1)).toBe(DELIVERY_RETRY.BASE_MS);
    expect(deliveryService.backoffMsFor(2)).toBe(DELIVERY_RETRY.BASE_MS * 2);
    expect(deliveryService.backoffMsFor(3)).toBe(DELIVERY_RETRY.BASE_MS * 4);
    expect(deliveryService.backoffMsFor(99)).toBe(DELIVERY_RETRY.MAX_DELAY_MS);
    /* Deterministic: no jitter, so a report can say when a retry is due and be
       right. Two calls agree. */
    expect(deliveryService.backoffMsFor(5)).toBe(deliveryService.backoffMsFor(5));
  });

  test("a terminal failure is never scheduled for retry", async () => {
    await grant();
    /* A rejected write — the request is wrong, and repeating it makes the same
       mistake again. */
    const { client } = clientWith({ failWith: { status: 400 } });
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();

    const s = await stateOf();
    expect(s.health).toBe("BLOCKED_TERMINAL");
    expect(s.nextAttemptAt).toBeNull();
    expect(s.reasonCode).toBe("MAUTIC_WRITE_REJECTED");
    /* And it is therefore never claimable. */
    expect(await deliveryService.claimDue({ companyId: COMPANY, now: new Date(Date.now() + 86400000) })).toHaveLength(0);
  });

  test("a refused credential is terminal, not retried", async () => {
    await grant();
    const { client } = clientWith({ failWith: { status: 401 } });
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();
    const s = await stateOf();
    expect(s.health).toBe("BLOCKED_TERMINAL");
    expect(s.reasonCode).toBe("MAUTIC_AUTH_REFUSED");
  });

  test("transient failures stop after the attempt budget and ask for a person", async () => {
    await grant();
    const { client } = clientWith({ failWith: { code: "ECONNREFUSED" } });

    for (let i = 0; i < DELIVERY_RETRY.MAX_ATTEMPTS; i++) {
      await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();
    }

    const s = await stateOf();
    /* "Retry transient failures" is not "retry for ever": eight failures are
       telling us something a ninth attempt will not. */
    expect(s.health).toBe("BLOCKED_TERMINAL");
    expect(s.reasonCode).toBe("RETRY_BUDGET_SPENT");
    expect(s.nextAttemptAt).toBeNull();
    expect(s.row.retryCount).toBe(DELIVERY_RETRY.MAX_ATTEMPTS);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. TWO WORKERS CANNOT CLAIM THE SAME ROW
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Claiming is safe against concurrent workers", () => {
  beforeEach(async () => {
    await grant();
    const { client } = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});
    /* Make it due. */
    await DeliveryState.updateOne({ gravPersonKey: KEY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
  });

  test("two concurrent claimDue calls split the work; neither gets the same row", async () => {
    const [a, b] = await Promise.all([
      deliveryService.claimDue({ companyId: COMPANY, by: "worker-a" }),
      deliveryService.claimDue({ companyId: COMPANY, by: "worker-b" }),
    ]);
    const claimedKeys = [...a, ...b].map((r) => r.gravPersonKey);
    expect(claimedKeys).toEqual([KEY]);          // exactly one worker won it
    expect(a.length + b.length).toBe(1);
  });

  test("a second claim is refused while the first is live", async () => {
    const first = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-a" });
    expect(first).toHaveLength(1);
    const second = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-b" });
    expect(second).toHaveLength(0);
  });

  test("an expired claim becomes available again, so a crashed worker strands nothing", async () => {
    await deliveryService.claimDue({ companyId: COMPANY, by: "crashed-worker" });
    const later = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const retaken = await deliveryService.claimDue({ companyId: COMPANY, now: later, by: "worker-b" });
    expect(retaken).toHaveLength(1);
    expect(retaken[0].claim.by).toBe("worker-b");
  });

  test("only the claim holder may release it", async () => {
    const [row] = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-a" });
    expect(await deliveryService.releaseClaim({ companyId: COMPANY, gravPersonKey: KEY, claimToken: "not-the-token" })).toBe(false);
    expect(await deliveryService.releaseClaim({ companyId: COMPANY, gravPersonKey: KEY, claimToken: row.claimToken })).toBe(true);
  });

  test("claims are company-scoped", async () => {
    expect(await deliveryService.claimDue({ companyId: OTHER_COMPANY })).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5-7. RECOVERY, IDEMPOTENCE, AND IDENTITY THROUGH AN EMAIL CHANGE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Recovery and idempotence", () => {
  test("a successful retry clears the error and records the success time", async () => {
    await grant();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await expect(sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON })).rejects.toBeTruthy();
    expect((await stateOf()).health).toBe("RETRY_SCHEDULED");

    const working = clientWith();
    const out = await sync.syncContact({ client: working.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON });

    const s = await stateOf();
    expect(s.health).toBe("SYNCHRONIZED");
    expect(s.effectiveHealth).toBe("SYNCHRONIZED");
    expect(s.row.activeError).toBeNull();
    expect(s.nextAttemptAt).toBeNull();
    expect(s.row.retryCount).toBe(0);
    expect(s.lastSuccessfulSyncAt).toBeInstanceOf(Date);
    expect(s.mauticContactId).toBe(String(out.contactId));
    expect(s.attempts).toBe(2);           // both attempts counted
  });

  test("repeating a successful projection stays idempotent", async () => {
    await grant();
    const { client, double } = clientWith();
    const first = await sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON });
    const second = await sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON });

    expect(second.contactId).toBe(first.contactId);
    expect(second.created).toBe(false);
    expect(double.state.contacts.size).toBe(1);
    expect(await DeliveryState.countDocuments({})).toBe(1);
    const s = await stateOf();
    expect(s.health).toBe("SYNCHRONIZED");
    expect(s.attempts).toBe(2);
  });

  test("changing the email preserves the person key and the linked Mautic contact", async () => {
    await grant();
    const { client, double } = clientWith();
    const first = await sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON });

    const moved = await sync.syncContact({
      client, companyId: COMPANY, gravPersonKey: KEY,
      person: { ...PERSON, workEmail: "meera.sharma@aurorahotels.in" },
    });

    /* THE REASON THE DURABLE KEY IS NOT AN EMAIL ADDRESS. One contact, one
       identity, one delivery row — and the mapping answered, so no search ran. */
    expect(moved.contactId).toBe(first.contactId);
    expect(moved.matchedBy).toBe("identity_mapping");
    expect(double.state.contacts.size).toBe(1);
    expect(await MarketingIdentity.countDocuments({})).toBe(1);
    expect(await DeliveryState.countDocuments({})).toBe(1);
    expect((await stateOf()).mauticContactId).toBe(String(first.contactId));
  });

  test("the retry runner recovers a due row and creates no second contact", async () => {
    await grant();
    await identity();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});
    await DeliveryState.updateOne({ gravPersonKey: KEY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });

    const working = clientWith();
    const summary = await deliveryService.runDueRetries({
      companyId: COMPANY,
      client: working.client,
      project: sync.syncContact,
      personFor: deliveryService.personFromIdentity,
    });

    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(working.double.state.contacts.size).toBe(1);
    const s = await stateOf();
    expect(s.health).toBe("SYNCHRONIZED");
    expect(s.row.claim.token).toBe("");
  });

  test("the retry runner does not let one bad row stop the rest", async () => {
    for (const k of ["p1", "p2"]) {
      await grant(k);
      await identity(k, `${k}@aurorahotels.in`);
    }
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    for (const k of ["p1", "p2"]) {
      await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: k, person: { workEmail: `${k}@aurorahotels.in`, firstName: k } }).catch(() => {});
    }
    await DeliveryState.updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });

    /* p2's consent is withdrawn between the failure and the retry, so its retry
       is refused while p1's succeeds. */
    await consentService.withdraw({
      companyId: COMPANY, gravPersonKey: "p2", ...consentService.MARKETING_EMAIL,
      reason: "asked to stop", actor: ACTOR,
    });

    const working = clientWith();
    const summary = await deliveryService.runDueRetries({
      companyId: COMPANY, client: working.client,
      project: sync.syncContact, personFor: deliveryService.personFromIdentity,
    });

    expect(summary.claimed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect((await stateOf("p1")).health).toBe("SYNCHRONIZED");
    /* Refused, not forced through — a retry is not a licence. */
    expect((await stateOf("p2")).health).toBe("BLOCKED_CONSENT");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8-9. CONSENT STILL GOVERNS, AND SUPPRESSION WINS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Consent still decides, and is recorded when it refuses", () => {
  test("unknown, opted-out and suppressed never reach the Mautic write call", async () => {
    const cases = [
      [null, "CONSENT_MISSING"],
      [{ state: "unknown" }, "CONSENT_UNKNOWN"],
      [{ state: "opted_out", reason: "stop" }, "CONSENT_WITHDRAWN"],
      [{ state: "suppressed", reason: "bounce" }, "CONSENT_SUPPRESSED"],
    ];
    for (const [write, reasonCode] of cases) {
      await MarketingConsent.deleteMany({});
      await DeliveryState.deleteMany({});
      if (write) {
        await consentService.record({
          companyId: COMPANY, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
          capturedSource: "test", actor: ACTOR, ...write,
        });
      }
      const { client, double } = clientWith();
      await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }))
        .rejects.toMatchObject({ code: "MARKETING_CONSENT_INELIGIBLE", details: expect.objectContaining({ reasonCode }) });

      /* Not one call. Not created and rolled back. */
      expect(double.state.calls).toHaveLength(0);

      /* And the refusal is queryable, which is how Data Health can answer
         "who is blocked" without re-resolving consent for everybody. */
      const s = await stateOf();
      expect(s.health).toBe("BLOCKED_CONSENT");
      expect(s.row.consentReasonCode).toBe(reasonCode);
      /* Nothing was attempted, so the attempt count stays at zero and the retry
         budget is not quietly consumed by a permission problem. */
      expect(s.attempts).toBe(0);
    }
  });

  test("suppression wins even when another purpose is opted in", async () => {
    await grant();
    await consentService.suppress({
      companyId: COMPANY, gravPersonKey: KEY,
      channel: "email", purpose: "transactional",
      reason: "mailbox does not exist", actor: null,
    });

    const { client, double } = clientWith();
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }))
      .rejects.toMatchObject({ details: expect.objectContaining({ reasonCode: "CONSENT_SUPPRESSED" }) });
    expect(double.state.calls).toHaveLength(0);

    /* And reconciliation agrees, rather than having its own opinion. */
    await identity();
    const report = await reconciliation.reconcile({ companyId: COMPANY });
    expect(report.counts.SUPPRESSED).toBe(1);
    expect(report.counts.RETRY_DUE).toBe(0);
  });

  test("a forged caller-supplied consent object is still refused", async () => {
    const { client, double } = clientWith();
    await expect(sync.syncContact({
      client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON,
      consent: { state: "opted_in" },
    })).rejects.toMatchObject({ code: "MARKETING_CONSENT_CALLER_SUPPLIED" });
    expect(double.state.calls).toHaveLength(0);
  });

  test("the projection allowlist is unchanged", async () => {
    await grant();
    const { client, double } = clientWith();
    await sync.syncContact({
      client, companyId: COMPANY, gravPersonKey: KEY,
      person: { ...PERSON, internalNote: "do not send this", margin: 42 },
    });
    const sent = double.state.calls.find((c) => c.url === "/api/contacts/new").data;
    expect(Object.keys(sent).sort()).toEqual([
      "company", "email", "firstname", "grav_person_key", "lastname", "position",
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. RECONCILIATION IS COMPANY-SCOPED AND READ-ONLY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Reconciliation inspects and never mutates", () => {
  test("it groups people into the documented categories", async () => {
    /* synchronized */
    await grant("ok1"); await identity("ok1", "ok1@a.in");
    const working = clientWith();
    await sync.syncContact({ client: working.client, companyId: COMPANY, gravPersonKey: "ok1", person: { workEmail: "ok1@a.in", firstName: "A" } });

    /* retry scheduled */
    await grant("retry1"); await identity("retry1", "retry1@a.in");
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: "retry1", person: { workEmail: "retry1@a.in", firstName: "B" } }).catch(() => {});

    /* terminal */
    await grant("term1"); await identity("term1", "term1@a.in");
    const rejecting = clientWith({ failWith: { status: 400 } });
    await sync.syncContact({ client: rejecting.client, companyId: COMPANY, gravPersonKey: "term1", person: { workEmail: "term1@a.in", firstName: "C" } }).catch(() => {});

    /* eligible, never attempted */
    await grant("new1"); await identity("new1", "new1@a.in");

    /* no consent at all */
    await identity("nocon1", "nocon1@a.in");

    /* suppressed */
    await grant("sup1"); await identity("sup1", "sup1@a.in");
    await consentService.suppress({
      companyId: COMPANY, gravPersonKey: "sup1", ...consentService.MARKETING_EMAIL,
      reason: "bounce", actor: null,
    });

    const report = await reconciliation.reconcile({ companyId: COMPANY });
    expect(report.counts).toMatchObject({
      SYNCHRONIZED: 1,
      RETRY_WAITING: 1,
      BLOCKED_TERMINAL: 1,
      MISSING_MAPPING: 1,
      CONSENT_INELIGIBLE: 1,
      SUPPRESSED: 1,
    });
    expect(report.totals.actionable).toBe(5);
    expect(report.reasonCounts.MAUTIC_UNREACHABLE).toBe(1);
  });

  test("a due retry is reported as due, and a waiting one as waiting", async () => {
    await grant(); await identity();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});

    expect((await reconciliation.reconcile({ companyId: COMPANY })).counts.RETRY_WAITING).toBe(1);
    const later = new Date(Date.now() + DELIVERY_RETRY.BASE_MS + 1000);
    expect((await reconciliation.reconcile({ companyId: COMPANY, now: later })).counts.RETRY_DUE).toBe(1);
  });

  test("it changes nothing it reads", async () => {
    await grant(); await identity();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});

    const before = await DeliveryState.findOne({}).lean();
    const consentBefore = await MarketingConsent.findOne({}).lean();

    await reconciliation.reconcile({ companyId: COMPANY });
    await reconciliation.reconcile({ companyId: COMPANY, now: new Date(Date.now() + 86400000) });
    await reconciliation.backlog({ companyId: COMPANY });

    expect(await DeliveryState.findOne({}).lean()).toEqual(before);
    expect(await MarketingConsent.findOne({}).lean()).toEqual(consentBefore);
  });

  test("it is company-scoped", async () => {
    await grant(KEY, OTHER_COMPANY);
    await identity(KEY, PERSON.workEmail, OTHER_COMPANY);
    const report = await reconciliation.reconcile({ companyId: COMPANY });
    expect(report.totals.people).toBe(0);
    const theirs = await reconciliation.reconcile({ companyId: OTHER_COMPANY });
    expect(theirs.totals.people).toBe(1);
  });

  test("it refuses to run without a company", async () => {
    await expect(reconciliation.reconcile({})).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    await expect(reconciliation.backlog({})).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });

  test("the backlog reports never-synchronized as null, never as a date or zero", async () => {
    const b = await reconciliation.backlog({ companyId: COMPANY });
    expect(b.lastSuccessfulSyncAt).toBeNull();
    expect(b.scheduled).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11-12. THE DATA HEALTH API
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Data Health is authenticated, company-scoped and safe", () => {
  test("it refuses an unauthenticated caller", async () => {
    expect((await call("/data-health", { user: null })).status).toBe(401);
    expect((await call("/data-health/records", { user: null })).status).toBe(401);
    expect((await call("/data-health/person/x", { user: null })).status).toBe(401);
  });

  test("it refuses a non-marketing role", async () => {
    expect((await call("/data-health", { user: OUTSIDER })).status).toBe(403);
  });

  test("the company comes from the session, not the query string", async () => {
    await grant(KEY, OTHER_COMPANY);
    await identity(KEY, PERSON.workEmail, OTHER_COMPANY);

    /* A caller naming another company gets their own, because the parameter is
       never read. */
    const res = await call(`/data-health?companyId=${OTHER_COMPANY}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.people).toBe(0);
  });

  test("a person key from another company is not found", async () => {
    await identity(KEY, PERSON.workEmail, OTHER_COMPANY);
    const res = await call(`/data-health/person/${KEY}`);
    expect(res.status).toBe(404);
  });

  test("the summary groups by stable reason codes and serves the vocabulary", async () => {
    await grant(); await identity();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});

    const res = await call("/data-health");
    expect(res.status).toBe(200);
    expect(res.body.counts.RETRY_WAITING).toBe(1);
    /* Grouped under the PUBLIC code. The stored row still carries the internal
       one; the translation happens at the response boundary. */
    expect(res.body.reasonCounts.MARKETING_ENGINE_UNREACHABLE).toBe(1);
    expect(res.body.reasonCounts.MAUTIC_UNREACHABLE).toBeUndefined();
    expect(res.body.retry).toMatchObject({ scheduled: 1, dueNow: 0, waiting: 1, maxAttempts: DELIVERY_RETRY.MAX_ATTEMPTS });
    expect(res.body.lastSuccessfulSyncAt).toBeNull();
    expect(res.body.complete).toBe(true);
    expect(res.body.vocabulary.categories).toEqual(reconciliation.CATEGORIES);
    /* The served vocabulary carries the PUBLIC code and a label that names no
       product. The internal code stays in the database and never appears here,
       or a client would build a lookup table keyed by the provider's name. */
    expect(res.body.vocabulary.reasons.some((r) => r.code === "MARKETING_ENGINE_UNREACHABLE")).toBe(true);
    expect(res.body.vocabulary.reasons.some((r) => r.code === "MAUTIC_UNREACHABLE")).toBe(false);
    expect(JSON.stringify(res.body.vocabulary)).not.toMatch(/mautic/i);
  });

  test("records are filterable, paginated, masked and leak no raw provider error", async () => {
    await grant(); await identity();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});

    const res = await call("/data-health/records?category=RETRY_WAITING&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);

    const rec = res.body.records[0];
    expect(rec.gravPersonKey).toBe(KEY);
    /* Masked, not the address. Enough to tell two rows apart and recognise a
       domain; not a contact export. */
    expect(rec.emailMasked).toBe("m***@aurorahotels.in");
    expect(rec.emailDomain).toBe("aurorahotels.in");
    expect(rec.reasonCode).toBe("MARKETING_ENGINE_UNREACHABLE");
    expect(rec.effectiveHealth).toBe("RETRY_WAITING");
    expect(rec.engineContactRef).toBeNull();
    expect(rec).not.toHaveProperty("mauticContactId");

    /* The operator sentence, and the upstream code — never a provider body. */
    /* Translated, not passed through. The upstream token stays in the logs. */
    expect(rec.lastErrorSourceCode).toBe("MARKETING_ENGINE_UNREACHABLE");
    expect(rec.lastErrorMessage).toContain("not an empty result");
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("meera@aurorahotels.in");
    expect(serialised).not.toContain(ENV.MAUTIC_BASIC_PASSWORD);
    expect(serialised).not.toContain("capturedSource");
    expect(serialised).not.toContain("noticeVersion");
  });

  test("an unknown category is a clean 400 naming what is accepted", async () => {
    const res = await call("/data-health/records?category=NONSENSE");
    expect(res.status).toBe(400);
    expect(res.body.error.details.accepted).toEqual(reconciliation.CATEGORIES);
  });

  test("one person's detail reports their state without consent evidence", async () => {
    await grant(); await identity();
    const working = clientWith();
    const out = await sync.syncContact({ client: working.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON });

    const res = await call(`/data-health/person/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.person.emailMasked).toBe("m***@aurorahotels.in");
    expect(res.body.person.engineContactRefs).toEqual([String(out.contactId)]);
    expect(res.body.delivery).toMatchObject({
      health: "SYNCHRONIZED", effectiveHealth: "SYNCHRONIZED", reasonCode: "DELIVERY_OK", attempts: 1,
    });
    expect(res.body.delivery.lastSuccessfulSyncAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("landing page form");
  });

  test("every Data Health route is a GET", () => {
    const layer = require("../../routes/CMS_Routes/Marketing/dataHealth");
    const methods = layer.stack.filter((l) => l.route)
      .map((l) => Object.keys(l.route.methods)[0].toUpperCase());
    expect([...new Set(methods)]).toEqual(["GET"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CORRECTION 1 — A FIRST FAILURE IS VISIBLE AND RECOVERABLE THROUGH THE API
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A first projection failure is discoverable and recoverable", () => {
  /* No identity is inserted by hand anywhere in this block. That is the point:
     the previous version of these tests created one, which hid the fact that
     production did not. */

  test("it reaches Data Health, keeps no false mapping, and recovers to exactly one contact", async () => {
    await grant();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await expect(sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }))
      .rejects.toMatchObject({ code: "MAUTIC_UNAVAILABLE" });

    /* No contact, and no mapping claiming one. */
    expect(broken.double.state.contacts.size).toBe(0);
    const idBefore = await MarketingIdentity.findOne({ gravPersonKey: KEY }).lean();
    expect((idBefore.externals || []).filter((e) => e.system === "mautic")).toHaveLength(0);

    /* ── THROUGH THE HTTP API, not the service ─────────────────────────── */
    const summary = await call("/data-health");
    expect(summary.status).toBe(200);
    expect(summary.body.counts.RETRY_WAITING).toBe(1);
    expect(summary.body.reasonCounts.MARKETING_ENGINE_UNREACHABLE).toBe(1);
    expect(summary.body.retry.scheduled).toBe(1);

    const records = await call("/data-health/records?category=RETRY_WAITING");
    expect(records.body.records).toHaveLength(1);
    expect(records.body.records[0]).toMatchObject({
      gravPersonKey: KEY,
      reasonCode: "MARKETING_ENGINE_UNREACHABLE",
      emailMasked: "m***@aurorahotels.in",
      engineContactRef: null,
    });
    /* Nothing in this row names the product, including the key names. */
    expect(JSON.stringify(records.body)).not.toMatch(/mautic/i);

    const person = await call(`/data-health/person/${KEY}`);
    expect(person.status).toBe(200);
    expect(person.body.person.engineContactRefs).toEqual([]);
    expect(person.body.delivery.effectiveHealth).toBe("RETRY_WAITING");

    /* ── AND THE RUNNER CAN FIND IT, with no hand-made identity ────────── */
    await DeliveryState.updateOne({ gravPersonKey: KEY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const working = clientWith();
    const run = await deliveryService.runDueRetries({
      companyId: COMPANY, client: working.client,
      project: sync.syncContact, personFor: deliveryService.personFromIdentity,
    });
    expect(run).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });

    /* Exactly one contact and exactly one mapping. */
    expect(working.double.state.contacts.size).toBe(1);
    const idAfter = await MarketingIdentity.findOne({ gravPersonKey: KEY }).lean();
    expect((idAfter.externals || []).filter((e) => e.system === "mautic")).toHaveLength(1);
    expect(await MarketingIdentity.countDocuments({})).toBe(1);

    const after = await call(`/data-health/person/${KEY}`);
    expect(after.body.delivery).toMatchObject({ health: "SYNCHRONIZED", reasonCode: "DELIVERY_OK" });
    expect(after.body.person.engineContactRefs).toHaveLength(1);
  });

  test("a consent refusal is discoverable too, without inventing a mapping", async () => {
    /* No consent at all. The identity is not written — nothing was projected and
       nothing may be — so the person is known to Data Health only if some other
       path recorded them. Here the delivery row alone exists, which is the honest
       result: consent is refused before an identity is created. */
    const { client, double } = clientWith();
    await expect(sync.syncContact({ client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }))
      .rejects.toMatchObject({ code: "MARKETING_CONSENT_INELIGIBLE" });
    expect(double.state.calls).toHaveLength(0);

    const s = await stateOf();
    expect(s.health).toBe("BLOCKED_CONSENT");
    /* The backlog counts it even though reconciliation's identity spine cannot
       list the person — a count that would otherwise silently read zero. */
    const summary = await call("/data-health");
    expect(summary.body.blocked.consent).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CORRECTION 2 — A STALE WORKER CANNOT SETTLE OVER A NEWER LEASE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Retry outcomes are fenced by the lease token", () => {
  /** A row sitting in a due retry, with no lease held. */
  async function dueRow() {
    await grant();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});
    await DeliveryState.updateOne({ gravPersonKey: KEY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
  }

  test("the deterministic race: expiry, reclamation, late completion", async () => {
    await dueRow();

    /* 1. Worker A claims. */
    const [a] = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-A" });
    expect(a.claimToken).toBeTruthy();

    /* 2. A's lease expires while A is still running. */
    const afterExpiry = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);

    /* 3. Worker B reclaims it. */
    const [b] = await deliveryService.claimDue({ companyId: COMPANY, now: afterExpiry, by: "worker-B" });
    expect(b.claimToken).toBeTruthy();
    expect(b.claimToken).not.toBe(a.claimToken);

    /* 4. B settles a newer result. */
    const bSettled = await deliveryService.recordSuccess({
      companyId: COMPANY, gravPersonKey: KEY, mauticContactId: "B-CONTACT", leaseToken: b.claimToken,
    });
    expect(bSettled.settled).toBe(true);

    /* 5. A finishes late and tries to settle. Every door is shut. */
    const aSuccess = await deliveryService.recordSuccess({
      companyId: COMPANY, gravPersonKey: KEY, mauticContactId: "A-CONTACT", leaseToken: a.claimToken,
    });
    const aFailure = await deliveryService.recordFailure({
      companyId: COMPANY, gravPersonKey: KEY,
      error: { code: "MAUTIC_UNAVAILABLE", message: "A's stale failure" }, leaseToken: a.claimToken,
    });
    const aBegin = await deliveryService.beginAttempt({
      companyId: COMPANY, gravPersonKey: KEY, leaseToken: a.claimToken,
    });

    expect(aSuccess).toMatchObject({ settled: false, reason: "LEASE_LOST" });
    expect(aFailure).toMatchObject({ settled: false, reason: "LEASE_LOST" });
    expect(aBegin).toMatchObject({ settled: false, reason: "LEASE_LOST" });

    /* THE FINAL STATE BELONGS ONLY TO THE CURRENT LEASE HOLDER. */
    const final = await DeliveryState.findOne({ gravPersonKey: KEY }).lean();
    expect(final.health).toBe("SYNCHRONIZED");
    expect(final.mauticContactId).toBe("B-CONTACT");
    expect(final.activeError).toBeNull();
    expect(final.retryCount).toBe(0);
    /* And A did not create a second row by upserting past the fence. */
    expect(await DeliveryState.countDocuments({})).toBe(1);
  });

  test("a stale worker cannot clear a newer worker's claim", async () => {
    await dueRow();
    const [a] = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-A" });
    const afterExpiry = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const [b] = await deliveryService.claimDue({ companyId: COMPANY, now: afterExpiry, by: "worker-B" });

    expect(await deliveryService.releaseClaim({ companyId: COMPANY, gravPersonKey: KEY, claimToken: a.claimToken })).toBe(false);
    const row = await DeliveryState.findOne({ gravPersonKey: KEY }).lean();
    expect(row.claim.token).toBe(b.claimToken);
    expect(row.claim.by).toBe("worker-B");
  });

  test("a stale worker cannot move the retry counters", async () => {
    await dueRow();
    const [a] = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-A" });
    const afterExpiry = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const [b] = await deliveryService.claimDue({ companyId: COMPANY, now: afterExpiry, by: "worker-B" });

    await deliveryService.recordFailure({
      companyId: COMPANY, gravPersonKey: KEY,
      error: { code: "MAUTIC_UNAVAILABLE", message: "B's failure" }, leaseToken: b.claimToken,
    });
    const afterB = await DeliveryState.findOne({ gravPersonKey: KEY }).lean();

    for (let i = 0; i < 3; i++) {
      await deliveryService.recordFailure({
        companyId: COMPANY, gravPersonKey: KEY,
        error: { code: "MAUTIC_UNAVAILABLE", message: "A again" }, leaseToken: a.claimToken,
      });
    }
    const afterA = await DeliveryState.findOne({ gravPersonKey: KEY }).lean();
    expect(afterA.retryCount).toBe(afterB.retryCount);
    expect(afterA.attempts).toBe(afterB.attempts);
    expect(afterA.nextAttemptAt.getTime()).toBe(afterB.nextAttemptAt.getTime());
  });

  test("an unfenced settle cannot stamp on a live lease", async () => {
    await dueRow();
    const [held] = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-A" });
    expect(held).toBeTruthy();

    /* A direct projection, holding no lease, while a worker owns the row. */
    const out = await deliveryService.recordSuccess({
      companyId: COMPANY, gravPersonKey: KEY, mauticContactId: "DIRECT",
    });
    expect(out).toMatchObject({ settled: false, reason: "LEASE_LOST" });
    expect((await DeliveryState.findOne({}).lean()).health).toBe("RETRY_SCHEDULED");
  });

  test("an expired lease nobody reclaimed still settles — its result is the only one", async () => {
    await dueRow();
    const [a] = await deliveryService.claimDue({ companyId: COMPANY, by: "worker-A" });
    const out = await deliveryService.recordSuccess({
      companyId: COMPANY, gravPersonKey: KEY, mauticContactId: "A-CONTACT", leaseToken: a.claimToken,
    });
    expect(out.settled).toBe(true);
    expect((await DeliveryState.findOne({}).lean()).mauticContactId).toBe("A-CONTACT");
  });

  test("the lease token is internal — no HTTP route can supply one", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Marketing", "dataHealth.js"), "utf8");
    expect(src).not.toMatch(/leaseToken|claimToken|__lease/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CORRECTION 3 — CRASHED ATTEMPTS ARE CLASSIFIED HONESTLY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("An attempt that started and never finished", () => {
  test("a newly opened attempt is neither a success nor a failure", async () => {
    await deliveryService.beginAttempt({ companyId: COMPANY, gravPersonKey: KEY });
    const s = await stateOf();
    expect(s.health).toBe("IN_FLIGHT");
    expect(s.row.lastOutcome).toBeNull();
    expect(s.lastSuccessfulSyncAt).toBeNull();
    expect(s.row.activeError).toBeNull();
    expect(s.attempts).toBe(1);
    /* The contradiction the old shape allowed: NEVER_ATTEMPTED with attempts>0. */
    expect(s.health).not.toBe("NEVER_ATTEMPTED");
  });

  test("after the stale threshold it is IN_FLIGHT_STALE with its own reason", async () => {
    await grant();
    /* The identity production writes before opening an attempt. Reconciliation
       walks identities, so a person without one is not walked — which is exactly
       the gap Correction 1 closed in the sync path. */
    await identity();
    await deliveryService.beginAttempt({ companyId: COMPANY, gravPersonKey: KEY });

    const fresh = await reconciliation.reconcile({ companyId: COMPANY });
    expect(fresh.counts.IN_FLIGHT).toBe(1);
    expect(fresh.counts.MISSING_MAPPING).toBe(0);
    expect(fresh.reasonCounts.DELIVERY_IN_FLIGHT).toBe(1);

    const later = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const stale = await reconciliation.reconcile({ companyId: COMPANY, now: later });
    expect(stale.counts.IN_FLIGHT_STALE).toBe(1);
    /* Its own reason, never DELIVERY_OK. */
    expect(stale.reasonCounts.DELIVERY_IN_FLIGHT_STALE).toBe(1);
    expect(stale.reasonCounts.DELIVERY_OK).toBeUndefined();
  });

  test("a crashed FIRST attempt is not reported as never projected", async () => {
    await grant();
    await identity();
    await deliveryService.beginAttempt({ companyId: COMPANY, gravPersonKey: KEY });
    const later = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const report = await reconciliation.reconcile({ companyId: COMPANY, now: later });
    /* The old order read this as MISSING_MAPPING — "never projected" — which is
       the one thing it definitely is not. */
    expect(report.counts.MISSING_MAPPING).toBe(0);
    expect(report.counts.IN_FLIGHT_STALE).toBe(1);
  });

  test("a crashed retry is reclaimable once its lease expires", async () => {
    await grant();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});
    await DeliveryState.updateOne({ gravPersonKey: KEY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });

    /* A worker claims it and opens the attempt, then dies. */
    const [a] = await deliveryService.claimDue({ companyId: COMPANY, by: "doomed-worker" });
    await deliveryService.beginAttempt({ companyId: COMPANY, gravPersonKey: KEY, leaseToken: a.claimToken });
    expect((await stateOf()).health).toBe("IN_FLIGHT");

    /* Nothing is claimable while the lease is live — the row is not abandoned. */
    expect(await deliveryService.claimDue({ companyId: COMPANY, by: "worker-B" })).toHaveLength(0);

    /* Once the lease has expired AND the attempt has outlived it, it is nobody's
       and can be picked up again. */
    const later = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const [b] = await deliveryService.claimDue({ companyId: COMPANY, now: later, by: "worker-B" });
    expect(b).toBeTruthy();
    expect(b.claimToken).not.toBe(a.claimToken);

    /* And the reclaim fences the original worker out. */
    expect(await deliveryService.recordSuccess({
      companyId: COMPANY, gravPersonKey: KEY, mauticContactId: "X", leaseToken: a.claimToken,
    })).toMatchObject({ settled: false });
  });

  test("a previous success survives a later crashed update", async () => {
    await grant();
    const working = clientWith();
    const out = await sync.syncContact({ client: working.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON });
    const syncedAt = (await stateOf()).lastSuccessfulSyncAt;
    expect(syncedAt).toBeInstanceOf(Date);

    /* A later update opens and never settles. */
    await deliveryService.beginAttempt({ companyId: COMPANY, gravPersonKey: KEY });

    const s = await stateOf();
    expect(s.health).toBe("IN_FLIGHT");
    /* The earlier success is still on record — losing it would report a person
       who synchronised last week as never reached. */
    expect(s.lastSuccessfulSyncAt.getTime()).toBe(syncedAt.getTime());
    expect(s.mauticContactId).toBe(String(out.contactId));

    const later = new Date(Date.now() + DELIVERY_RETRY.CLAIM_TTL_MS + 1000);
    const report = await reconciliation.reconcile({ companyId: COMPANY, now: later });
    expect(report.counts.IN_FLIGHT_STALE).toBe(1);
    expect(report.people[0].lastSuccessfulSyncAt.getTime()).toBe(syncedAt.getTime());
  });

  test("invariants hold on findOneAndUpdate, which is what production uses", async () => {
    /* ── THE GAP THIS CLOSES ──────────────────────────────────────────────
       The rules were originally a `pre("validate")` hook, which mongoose runs
       for create() and save() and NOT for findOneAndUpdate() — the mechanism
       every write in the delivery service uses. The claim of safety held only
       where the tests were looking. */
    await DeliveryState.create({ companyId: COMPANY, gravPersonKey: KEY, health: "NEVER_ATTEMPTED" });

    await expect(DeliveryState.findOneAndUpdate(
      { gravPersonKey: KEY },
      { $set: { health: "SYNCHRONIZED", lastSuccessfulSyncAt: new Date(), activeError: { reasonCode: "MAUTIC_UNREACHABLE", failureClass: "TRANSIENT", at: new Date() } } },
    )).rejects.toThrow(/SYNCHRONIZED and still carry an active error/);

    await expect(DeliveryState.findOneAndUpdate(
      { gravPersonKey: KEY }, { $set: { health: "RETRY_SCHEDULED" } },
    )).rejects.toThrow(/without a nextAttemptAt/);

    await expect(DeliveryState.updateOne(
      { gravPersonKey: KEY }, { $set: { health: "IN_FLIGHT" }, $inc: { attempts: 1 } },
    )).rejects.toThrow(/IN_FLIGHT without inFlightSince/);

    await expect(DeliveryState.findOneAndUpdate(
      { gravPersonKey: KEY }, { $inc: { attempts: 1 } },
    )).rejects.toThrow(/NEVER_ATTEMPTED after an attempt/);

    /* And the row is untouched by every one of those refusals. */
    const row = await DeliveryState.findOne({ gravPersonKey: KEY }).lean();
    expect(row.health).toBe("NEVER_ATTEMPTED");
    expect(row.attempts).toBe(0);
  });

  test("the service and the database enforce the same rule, not two copies", () => {
    const { invariantViolation } = require("../../models/CMS_Models/Marketing/MarketingDeliveryState");
    expect(typeof invariantViolation).toBe("function");
    expect(invariantViolation({ health: "IN_FLIGHT", attempts: 1 })).toMatch(/inFlightSince/);
    expect(invariantViolation({ health: "IN_FLIGHT", attempts: 1, inFlightSince: new Date() })).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   14. THE SALES BOUNDARY IS UNCHANGED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Nothing here touches Sales", () => {
  test("projecting, failing, retrying and reporting create no Sales record", async () => {
    await grant(); await identity();
    const broken = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await sync.syncContact({ client: broken.client, companyId: COMPANY, gravPersonKey: KEY, person: PERSON }).catch(() => {});
    await DeliveryState.updateOne({ gravPersonKey: KEY }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const working = clientWith();
    await deliveryService.runDueRetries({
      companyId: COMPANY, client: working.client,
      project: sync.syncContact, personFor: deliveryService.personFromIdentity,
    });
    await call("/data-health");
    await call("/data-health/records");

    expect(await Lead.countDocuments({})).toBe(0);
    expect(await Enquiry.countDocuments({})).toBe(0);
    expect(await SalesJourney.countDocuments({})).toBe(0);
    expect(await Account.countDocuments({})).toBe(0);
  });

  test("the new modules load no Sales model", () => {
    const fs = require("fs");
    const path = require("path");
    for (const f of [
      "services/marketing/marketingDelivery.service.js",
      "services/marketing/marketingReconciliation.service.js",
      "routes/CMS_Routes/Marketing/dataHealth.js",
      "models/CMS_Models/Marketing/MarketingDeliveryState.js",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", f), "utf8");
      expect(src).not.toMatch(/require\([^)]*Sales\//);
      expect(src).not.toMatch(/require\([^)]*Lead/);
    }
  });

  test("the reconciliation service cannot reach a Mautic client at all", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "services", "marketing", "marketingReconciliation.service.js"), "utf8");
    /* A reconciliation that could enrol somebody is a reconciliation that will,
       the first time a loop is written slightly wrong. */
    expect(src).not.toMatch(/mauticClient|mauticContactSync|MauticClient/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CONTRADICTORY STATE IS REFUSED AT THE SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

describe("The delivery-state model refuses contradictions", () => {
  const base = () => ({ companyId: COMPANY, gravPersonKey: "contradiction-test" });

  test("SYNCHRONIZED cannot carry an active error, lack a success time, or schedule a retry", async () => {
    await expect(DeliveryState.create({
      ...base(), health: "SYNCHRONIZED", lastSuccessfulSyncAt: new Date(),
      activeError: { reasonCode: "MAUTIC_UNREACHABLE", failureClass: "TRANSIENT", at: new Date() },
    })).rejects.toThrow(/SYNCHRONIZED and still carry an active error/);

    await expect(DeliveryState.create({ ...base(), health: "SYNCHRONIZED" }))
      .rejects.toThrow(/without a successful sync time/);

    await expect(DeliveryState.create({
      ...base(), health: "SYNCHRONIZED", lastSuccessfulSyncAt: new Date(), nextAttemptAt: new Date(),
    })).rejects.toThrow(/SYNCHRONIZED and have a retry scheduled/);
  });

  test("RETRY_SCHEDULED needs both a time and the error that caused it", async () => {
    await expect(DeliveryState.create({ ...base(), health: "RETRY_SCHEDULED", attempts: 1 }))
      .rejects.toThrow(/without a nextAttemptAt/);
    await expect(DeliveryState.create({
      ...base(), health: "RETRY_SCHEDULED", attempts: 1, nextAttemptAt: new Date(),
    })).rejects.toThrow(/without the error that scheduled it/);
  });

  test("NEVER_ATTEMPTED after an attempt, and a blocked row with a retry, are refused", async () => {
    await expect(DeliveryState.create({ ...base(), health: "NEVER_ATTEMPTED", attempts: 3 }))
      .rejects.toThrow(/NEVER_ATTEMPTED after an attempt/);
    await expect(DeliveryState.create({
      ...base(), health: "BLOCKED_TERMINAL", attempts: 1, nextAttemptAt: new Date(),
    })).rejects.toThrow(/must not have a retry scheduled/);
  });
});
