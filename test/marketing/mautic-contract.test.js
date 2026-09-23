// test/marketing/mautic-contract.test.js
//
// THE MAUTIC CONTRACT, PROVED WITHOUT A MAUTIC.
//
// Every test here runs the PRODUCTION client, sync service, health check,
// webhook contract and intake ledger. The only substitution is the transport:
// `createMauticDouble()` stands in for the network, reproducing Mautic 7.2.0's
// recorded response shapes — including the three that actually break
// integrations (contacts keyed by id rather than an array; create answering
// 200 rather than 201; a repeat segment add answering success).
//
// That is deliberately as far as a test can honestly go. It proves the
// contract this repository has written down. It does NOT prove a live Mautic
// behaves that way, and `docs/handoff/mautic-chunk-0-contract.md` lists every
// difference the two are known to have.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { MauticClient, readConfig } = require("../../services/marketing/mauticClient");
const { createMauticDouble } = require("../../services/marketing/mauticTestDouble");
const sync = require("../../services/marketing/mauticContactSync.service");
const consentService = require("../../services/marketing/marketingConsent.service");
const health = require("../../services/marketing/mauticHealth.service");
const contract = require("../../services/marketing/mauticWebhookContract");
const eventIntake = require("../../services/marketing/mauticEventIntake.service");
const MarketingIdentity = require("../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");

const ENV = {
  MAUTIC_BASE_URL: "http://localhost:8088",
  MAUTIC_AUTH_MODE: "basic",
  MAUTIC_BASIC_USERNAME: "grav-integration",
  MAUTIC_BASIC_PASSWORD: "not-a-real-password",
  MAUTIC_HTTP_RETRIES: "1",
};

const OAUTH_ENV = {
  MAUTIC_BASE_URL: "http://localhost:8088",
  MAUTIC_AUTH_MODE: "oauth2",
  MAUTIC_OAUTH_CLIENT_ID: "client",
  MAUTIC_OAUTH_CLIENT_SECRET: "secret",
  MAUTIC_HTTP_RETRIES: "1",
};

const PERSON = {
  firstName: "Meera",
  lastName: "Sharma",
  jobTitle: "Head of Procurement",
  workEmail: "meera@aurorahotels.in",
  workPhone: "9876500011",
  companyName: "Aurora Hotels Pvt Ltd",
};
/* ── CONSENT IS A RECORD NOW, NOT AN ARGUMENT ───────────────────────────────
   Chunk 1 slice 1 removed syncContact's `consent` parameter. These tests grant
   permission the way production does — by writing the canonical record — so
   what they exercise is the real resolver rather than a value they handed in. */
async function grantMarketingEmail(key = KEY, overrides = {}) {
  return consentService.record({
    companyId,
    gravPersonKey: key,
    ...consentService.MARKETING_EMAIL,
    state: "opted_in",
    capturedSource: "test: landing page form",
    capturedAt: new Date("2026-09-01T10:00:00Z"),
    noticeVersion: "v3",
    evidenceRef: "form-submission-1",
    actor: { name: "Test Marketer", id: new mongoose.Types.ObjectId() },
    ...overrides,
  });
}

const companyId = new mongoose.Types.ObjectId();
const KEY = "grav-person-key-0001";

/** The production client, wired to the synthetic contract. */
function clientWith(opts = {}, env = ENV) {
  const double = createMauticDouble(opts);
  return { client: new MauticClient({ env, transport: { request: double.request } }), double };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. INVALID CONFIGURATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Invalid configuration is refused, by name", () => {
  test("nothing set names every missing variable at once", () => {
    const problems = readConfig({}).problems;
    expect(problems).toEqual(expect.arrayContaining([
      "MAUTIC_BASE_URL is not set.",
      "MAUTIC_OAUTH_CLIENT_ID is not set.",
      "MAUTIC_OAUTH_CLIENT_SECRET is not set.",
    ]));
  });

  test("an unknown auth mode is refused rather than defaulted to the weaker one", () => {
    const problems = readConfig({ ...ENV, MAUTIC_AUTH_MODE: "apikey" }).problems;
    expect(problems.join(" ")).toContain('MAUTIC_AUTH_MODE must be "oauth2" or "basic"');
  });

  test("plain http to a non-local host is refused; to localhost it is allowed", () => {
    expect(readConfig({ ...ENV, MAUTIC_BASE_URL: "http://mautic.example.com" }).problems.join(" "))
      .toContain("plain http to a non-local host");
    expect(readConfig(ENV).configured).toBe(true);
  });

  test("an unconfigured client refuses to call rather than trying and failing", async () => {
    const c = new MauticClient({ env: {}, transport: { request: async () => { throw new Error("must not be called"); } } });
    await expect(c.listSegments()).rejects.toMatchObject({ code: "MAUTIC_NOT_CONFIGURED", status: 409 });
  });

  test("health reports the configuration failure and leaves the rest UNKNOWN, not failed", async () => {
    const report = await health.check({ env: {} });
    expect(report.healthy).toBe(false);
    expect(report.checks.configuration.state).toBe("failed");
    /* The distinction that matters: nobody should be sent to look at Mautic. */
    expect(report.checks.reachability.state).toBe("unknown");
    expect(report.checks.authentication.state).toBe("unknown");
    expect(report.segmentCount).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. MAUTIC UNAVAILABLE — AND NEVER A FALSE ZERO
   ═══════════════════════════════════════════════════════════════════════════ */

describe("An unavailable Mautic is unavailable, not empty", () => {
  test("a refused connection raises 503, not an empty list", async () => {
    const { client } = clientWith({ failWith: { code: "ECONNREFUSED" } });
    await expect(client.listSegments()).rejects.toMatchObject({
      code: "MAUTIC_UNAVAILABLE", status: 503,
    });
  });

  test("a timeout raises 503 after the configured retries, not a zero count", async () => {
    const { client, double } = clientWith({ failWith: { code: "ETIMEDOUT" } });
    await expect(client.findContactByEmail("meera@aurorahotels.in"))
      .rejects.toMatchObject({ code: "MAUTIC_UNAVAILABLE" });
    /* One initial attempt plus one retry, each preceded by a token call. */
    const contactCalls = double.state.calls.filter((c) => c.url === "/api/contacts");
    expect(contactCalls.length).toBe(2);
  });

  test("a 503 from Mautic is retried; a 400 is not", async () => {
    const five = clientWith({ failWith: { status: 503 } });
    await expect(five.client.listSegments()).rejects.toMatchObject({ code: "MAUTIC_UNAVAILABLE" });
    expect(five.double.state.calls.filter((c) => c.url === "/api/segments").length).toBe(2);

    const four = clientWith({ failWith: { status: 400 } });
    /* ── UPDATED IN CHUNK 1 SLICE 2, AND THE OLD ASSERTION WAS THE BUG ──────
       This previously expected status 503 / MAUTIC_UNAVAILABLE, because the read
       helpers mapped EVERY non-200 to "unavailable". That was wrong in a way
       only a retry policy exposes: a malformed query is not an outage, and
       classifying it as one sent it into six hours of backoff it could never
       succeed from, hidden among the genuine outages. A refused request now
       raises MAUTIC_BAD_REQUEST, which the delivery state machine classifies
       TERMINAL. */
    await expect(four.client.listSegments()).rejects.toMatchObject({
      status: 400, code: "MAUTIC_BAD_REQUEST",
    });
    /* Refused once either way. Retrying a 400 is a way of making the same
       mistake twice. */
    expect(four.double.state.calls.filter((c) => c.url === "/api/segments").length).toBe(1);
  });

  test("a 5xx read is still an outage, so the two are genuinely distinguished", async () => {
    const { client } = clientWith({ failWith: { status: 502 } });
    await expect(client.listSegments()).rejects.toMatchObject({
      status: 503, code: "MAUTIC_UNAVAILABLE",
    });
  });

  test("health reports unavailability without inventing a segment count", async () => {
    const { client } = clientWith({ failWith: { code: "ECONNREFUSED" } });
    const report = await health.check({ client, env: ENV });
    expect(report.healthy).toBe(false);
    expect(report.checks.reachability.state).toBe("failed");
    expect(report.checks.database.state).toBe("unknown");
    /* THE RULE: unknown is null. A dashboard wanting a number gets nothing
       rather than a zero it would present as fact. */
    expect(report.segmentCount).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. AUTHENTICATION FAILURE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Authentication failure is terminal and says so", () => {
  test("a rejected OAuth2 token is 502 and is not retried", async () => {
    const { client, double } = clientWith({ rejectAuth: true }, OAUTH_ENV);
    await expect(client.listSegments()).rejects.toMatchObject({
      code: "MAUTIC_AUTH_FAILED", status: 502,
    });
    expect(double.state.calls.filter((c) => c.url === "/oauth/v2/token").length).toBe(1);
  });

  test("a 401 on an API call is terminal — hammering a bad credential locks it out", async () => {
    const { client, double } = clientWith({ failWith: { status: 401 } });
    await expect(client.listSegments()).rejects.toMatchObject({ code: "MAUTIC_AUTH_FAILED" });
    expect(double.state.calls.filter((c) => c.url === "/api/segments").length).toBe(1);
  });

  test("health separates 'Mautic answered' from 'Mautic accepted us'", async () => {
    const { client } = clientWith({ failWith: { status: 403 } });
    const report = await health.check({ client, env: ENV });
    expect(report.checks.reachability.state).toBe("ok");
    expect(report.checks.authentication.state).toBe("failed");
  });

  test("an OAuth2 token is minted once and reused", async () => {
    const { client, double } = clientWith({}, OAUTH_ENV);
    await client.listSegments();
    await client.listSegments();
    expect(double.state.tokensIssued).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4-5. CONTACT CREATION AND IDEMPOTENT UPDATE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("One consented person becomes one Mautic contact", () => {
  /* The canonical grant, written before each test. Nothing here passes consent
     to syncContact — it reads the record these lines create. */
  beforeEach(async () => { await grantMarketingEmail(); });

  test("creates the contact, writes the mapping, and sends only the allowlist", async () => {
    const { client, double } = clientWith();
    const out = await sync.syncContact({
      client, companyId, gravPersonKey: KEY,
      person: { ...PERSON, internalNote: "do not send this" },
    });

    expect(out.created).toBe(true);
    expect(out.matchedBy).toBe("created");
    expect(double.state.contacts.size).toBe(1);

    const sent = double.state.calls.find((c) => c.url === "/api/contacts/new").data;
    expect(sent).toEqual({
      email: "meera@aurorahotels.in",
      firstname: "Meera",
      lastname: "Sharma",
      company: "Aurora Hotels Pvt Ltd",
      phone: "9876500011",
      position: "Head of Procurement",
      grav_person_key: KEY,
    });
    /* Mautic is not a second customer master. Nothing off the allowlist rides
       along, however the caller spells it. */
    expect(sent.internalNote).toBeUndefined();

    const identity = await MarketingIdentity.findOne({ companyId, gravPersonKey: KEY }).lean();
    expect(identity.externals).toEqual([expect.objectContaining({
      system: "mautic", externalId: String(out.contactId), proven: true,
    })]);
  });

  test("a second sync updates in place and creates no second contact", async () => {
    const { client, double } = clientWith();
    const first = await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    const second = await sync.syncContact({
      client, companyId, gravPersonKey: KEY,
      person: { ...PERSON, jobTitle: "Group Head of Procurement" },
    });

    expect(second.created).toBe(false);
    expect(second.contactId).toBe(first.contactId);
    /* Path 1: the mapping row answered, so no search ran at all. */
    expect(second.matchedBy).toBe("identity_mapping");
    expect(double.state.contacts.size).toBe(1);
    expect(double.state.calls.filter((c) => c.url === "/api/contacts").length).toBe(1);
    expect(double.state.contacts.get(String(first.contactId)).position).toBe("Group Head of Procurement");
  });

  test("a changed email address keeps one identity rather than creating a second", async () => {
    const { client, double } = clientWith();
    const first = await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    const moved = await sync.syncContact({
      client, companyId, gravPersonKey: KEY,
      person: { ...PERSON, workEmail: "meera.sharma@aurorahotels.in" },
    });

    /* THE REASON THE KEY IS NOT THE EMAIL. An integration matching on the
       address would have created a second contact here, and then written to
       whichever one it found next time. */
    expect(moved.contactId).toBe(first.contactId);
    expect(moved.created).toBe(false);
    expect(double.state.contacts.size).toBe(1);
  });

  test("an existing Mautic contact with the same email is adopted, not duplicated", async () => {
    const { client, double } = clientWith();
    await client.createContact({ email: "meera@aurorahotels.in", firstname: "M" });
    expect(double.state.contacts.size).toBe(1);

    const out = await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    expect(out.matchedBy).toBe("email_exact");
    expect(out.created).toBe(false);
    expect(double.state.contacts.size).toBe(1);
  });

  test("the lookup is an exact email filter, never a fuzzy search", async () => {
    const { client, double } = clientWith();
    await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    const lookup = double.state.calls.find((c) => c.url === "/api/contacts" && c.method === "GET");
    expect(lookup.params["where[0][col]"]).toBe("email");
    expect(lookup.params["where[0][expr]"]).toBe("eq");
    expect(lookup.params.search).toBeUndefined();
  });

  test("Mautic's object-keyed `contacts` is read correctly, not as an empty array", async () => {
    /* The single most common integration bug against this API. If it were read
       as an array, `found` would be false and a duplicate contact would be
       created for a person Mautic already holds. */
    const { client } = clientWith();
    await client.createContact({ email: "meera@aurorahotels.in" });
    const found = await client.findContactByEmail("MEERA@aurorahotels.in");
    expect(found.found).toBe(true);
    expect(found.contact.id).toBe(1);
  });

  test("a person who has not opted in is never projected into Mautic", async () => {
    /* The canonical record decides, so each case is a real recorded state
       rather than an argument. Consent was granted by this describe's
       beforeEach, so each case overwrites it and must then be refused. */
    const cases = [
      ["unknown", { state: "unknown" }, "CONSENT_UNKNOWN"],
      ["opted_out", { state: "opted_out", reason: "asked to stop" }, "CONSENT_WITHDRAWN"],
      ["suppressed", { state: "suppressed", reason: "hard bounce" }, "CONSENT_SUPPRESSED"],
    ];
    for (const [label, overrides, reasonCode] of cases) {
      await consentService.record({
        companyId, gravPersonKey: KEY, ...consentService.MARKETING_EMAIL,
        capturedSource: "test", actor: { name: "t" }, ...overrides,
      });
      const { client, double } = clientWith();
      await expect(sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON }))
        .rejects.toMatchObject({
          status: 403,
          code: "MARKETING_CONSENT_INELIGIBLE",
          details: expect.objectContaining({ reasonCode }),
        });
      /* Refused BEFORE Mautic was touched at all — not created and rolled back. */
      expect(double.state.contacts.size).toBe(0);
      expect(double.state.calls.length).toBe(0);
      expect(label).toBeTruthy();
    }
  });

  test("a forged caller-supplied consent object is refused, not ignored", async () => {
    /* THE VULNERABILITY THIS SLICE CLOSES. Before Chunk 1, this exact call
       enrolled anybody. There is deliberately NO consent record here, so if the
       parameter were merely ignored the call would fail 403 for a missing
       record — which would pass a laxer test while leaving callers believing
       they can grant permission. It must fail 400 naming the parameter. */
    const { client, double } = clientWith();
    await expect(sync.syncContact({
      client, companyId, gravPersonKey: KEY, person: PERSON,
      consent: { state: "opted_in", emailConsent: "opted_in" },
    })).rejects.toMatchObject({
      status: 400,
      code: "MARKETING_CONSENT_CALLER_SUPPLIED",
      details: { field: "consent" },
    });
    expect(double.state.calls.length).toBe(0);

    /* Every spelling an existing caller might reach for. */
    for (const field of ["emailConsent", "consentState", "suppressed", "optedIn"]) {
      await expect(sync.syncContact({
        client, companyId, gravPersonKey: KEY, person: PERSON, [field]: "opted_in",
      })).rejects.toMatchObject({ status: 400, code: "MARKETING_CONSENT_CALLER_SUPPLIED", details: { field } });
    }

    /* And it is refused even when the person IS genuinely opted in, because the
       parameter is wrong regardless of whether it happens to agree. */
    await grantMarketingEmail();
    await expect(sync.syncContact({
      client, companyId, gravPersonKey: KEY, person: PERSON, consent: { state: "opted_in" },
    })).rejects.toMatchObject({ code: "MARKETING_CONSENT_CALLER_SUPPLIED" });
  });

  test("missing required identifiers are refused before any call is made", async () => {
    const { client, double } = clientWith();
    /* Consent is already granted by this describe's beforeEach, so each refusal
       below is about the identifier and not a consent failure wearing a 400. */
    await expect(sync.syncContact({ client, companyId, gravPersonKey: "", person: PERSON }))
      .rejects.toMatchObject({ status: 400 });
    await expect(sync.syncContact({ client, companyId, gravPersonKey: KEY, person: { firstName: "X" } }))
      .rejects.toMatchObject({ status: 400 });
    await expect(sync.syncContact({ client, companyId: null, gravPersonKey: KEY, person: PERSON }))
      .rejects.toMatchObject({ status: 403 });
    expect(double.state.calls.length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. SEGMENT ENROLMENT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Segment enrolment is proved by reading it back", () => {
  beforeEach(async () => { await grantMarketingEmail(); });

  test("resolves an alias to an id, enrols, and confirms membership", async () => {
    const { client, double } = clientWith();
    const person = await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    const out = await sync.enrolInSegment({ client, contactId: person.contactId, segment: "grav-integration-test" });

    expect(out.segmentId).toBe("7");
    expect(out.enrolled).toBe(true);
    /* The read-back is the proof. Mautic answers `{success:true}` either way,
       so the write's own answer cannot distinguish enrolled from ignored. */
    expect(double.state.calls.some((c) => c.url === `/api/contacts/${person.contactId}/segments`)).toBe(true);
  });

  test("enrolling twice is idempotent and leaves one membership", async () => {
    const { client, double } = clientWith();
    const person = await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    await sync.enrolInSegment({ client, contactId: person.contactId, segment: "7" });
    await sync.enrolInSegment({ client, contactId: person.contactId, segment: "7" });
    expect([...double.state.membership.get(String(person.contactId))]).toEqual(["7"]);
  });

  test("an unknown segment is a clean 404 naming what does exist", async () => {
    const { client } = clientWith();
    const person = await sync.syncContact({ client, companyId, gravPersonKey: KEY, person: PERSON });
    await expect(sync.enrolInSegment({ client, contactId: person.contactId, segment: "no-such-segment" }))
      .rejects.toMatchObject({ status: 404, details: { available: ["grav-integration-test"] } });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. THE WEBHOOK: SIGNATURE, ENVELOPE, REPLAY
   ═══════════════════════════════════════════════════════════════════════════ */

const SECRET = "chunk-0-webhook-secret";
const sign = (body, secret = SECRET, encoding = "base64") =>
  crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest(encoding);

const MAUTIC_PAYLOAD = {
  "mautic.form_on_submit": [{
    submission: {
      id: 902,
      dateSubmitted: "2026-09-09T08:00:00+00:00",
      form: { id: 3, name: "Housekeeping uniform guide" },
      results: { email: "meera@aurorahotels.in", product_interest: "housekeeping uniforms" },
      lead: { id: 44, email: "meera@aurorahotels.in" },
    },
    timestamp: "2026-09-09T08:00:01+00:00",
  }],
  "mautic.page_on_hit": [{
    hit: {
      id: 5511,
      dateHit: "2026-09-09T08:05:00+00:00",
      url: "https://grav.in/uniforms",
      email: { id: 12, name: "September uniform refresh" },
      lead: { id: 44, email: "meera@aurorahotels.in" },
    },
    timestamp: "2026-09-09T08:05:01+00:00",
  }],
  /* Chunk 2 translates this: "we attempted the send" is one of the six email
     facts. It carries a contact so it is attributable, like a real one. */
  "mautic.email_on_send": [{
    stat: {
      id: 77, emailAddress: "meera@aurorahotels.in", dateSent: "2026-09-09T07:59:00+00:00",
      email: { id: 12, name: "September uniform refresh" },
      lead: { id: 44, fields: { core: { email: { value: "meera@aurorahotels.in" } } } },
    },
    timestamp: "2026-09-09T07:59:01+00:00",
  }],
};

describe("The webhook contract matches real Mautic", () => {
  test("accepts Mautic's own base64 Webhook-Signature", () => {
    const body = JSON.stringify(MAUTIC_PAYLOAD);
    const check = contract.verifySignature(Buffer.from(body), sign(body), SECRET);
    expect(check).toMatchObject({ ok: true, encoding: "base64" });
  });

  test("also accepts a hex digest, so GRAV's own sender keeps working", () => {
    const body = JSON.stringify(MAUTIC_PAYLOAD);
    expect(contract.verifySignature(Buffer.from(body), sign(body, SECRET, "hex"), SECRET))
      .toMatchObject({ ok: true, encoding: "hex" });
  });

  test("rejects a wrong secret, a tampered body and a missing signature", () => {
    const body = JSON.stringify(MAUTIC_PAYLOAD);
    expect(contract.verifySignature(Buffer.from(body), sign(body, "wrong"), SECRET).ok).toBe(false);
    expect(contract.verifySignature(Buffer.from(body + " "), sign(body), SECRET).ok).toBe(false);
    expect(contract.verifySignature(Buffer.from(body), "", SECRET).ok).toBe(false);
  });

  test("rejects everything when no secret is configured", () => {
    const body = JSON.stringify(MAUTIC_PAYLOAD);
    const check = contract.verifySignature(Buffer.from(body), sign(body), "");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("No Mautic webhook secret is configured");
  });

  test("reads the signature from Mautic's header first", () => {
    expect(contract.signatureFrom({ "webhook-signature": "abc" })).toEqual({ value: "abc", header: "webhook-signature" });
    expect(contract.signatureFrom({ "x-mautic-signature": "def" })).toEqual({ value: "def", header: "x-mautic-signature" });
    expect(contract.signatureFrom({})).toEqual({ value: "", header: "" });
  });

  test("translates the grouped envelope into ledger events with derived ids", () => {
    const { events, ignored, rejected } = contract.translate(MAUTIC_PAYLOAD);
    expect(rejected).toEqual([]);
    /* ── UPDATED IN CHUNK 2 ────────────────────────────────────────────────
       `mautic.email_on_send` used to be ignored by name. It is now translated,
       because "we attempted the send" is one of the six email facts the ledger
       has to carry — as telemetry that never reaches the CRM timeline, not as
       engagement. The fixture's stat has an id, so it translates. */
    expect(ignored).toEqual([]);

    /* MANY events in ONE post. An intake reading the body as a single event
       would have dropped the second one. */
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind).sort()).toEqual(["email_clicked", "email_sent", "form_submitted"]);
    expect(events.find((e) => e.kind === "form_submitted")).toMatchObject({
      sourceEventId: "mautic.form_on_submit:submission:902",
      kind: "form_submitted",
      email: "meera@aurorahotels.in",
      externalContactId: "44",
      assetName: "Housekeeping uniform guide",
      topics: ["housekeeping uniforms"],
    });
    /* A hit carrying an email reference is a click-through, not a page view —
       calling it a view would understate intent, and calling every view a
       click would inflate it. */
    expect(events.find((e) => e.kind === "email_clicked")).toMatchObject({
      sourceEventId: "mautic.page_on_hit:hit:5511",
    });
  });

  test("a plain page hit is a page view, not a click", () => {
    const { events } = contract.translate({
      "mautic.page_on_hit": [{ hit: { id: 9, dateHit: "2026-09-09T09:00:00+00:00", lead: { id: 44, email: "a@b.in" } } }],
    });
    expect(events[0].kind).toBe("page_viewed");
  });

  test("an item with no record id is rejected rather than given an invented one", () => {
    const { events, rejected } = contract.translate({
      "mautic.form_on_submit": [{ submission: { lead: { email: "a@b.in" } } }],
    });
    expect(events).toHaveLength(0);
    expect(rejected[0].reason).toContain("cannot be deduplicated");
  });

  test("an event naming no contact is rejected — it cannot be attributed", () => {
    const { events, rejected } = contract.translate({
      "mautic.form_on_submit": [{ submission: { id: 5, dateSubmitted: "2026-09-09T08:00:00Z" } }],
    });
    expect(events).toHaveLength(0);
    expect(rejected[0].reason).toContain("names no contact");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7b. THE REAL PAYLOAD — captured from a live Mautic 7.2.0 delivery
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A real Mautic 7.2.0 webhook payload", () => {
  const fixture = require("./fixtures/mautic-7.2.0-email-open.json");

  test("the contact's email is found where Mautic actually puts it", () => {
    const { events, rejected } = contract.translate(fixture.payload);
    expect(rejected).toEqual([]);
    expect(events).toHaveLength(1);

    /* THE REGRESSION THIS FIXTURE EXISTS FOR. The webhook serializer emits
       field GROUPS of full descriptors, not the flat `fields.all` the REST API
       returns — and `stat.lead` carries no `email` key at all. The first
       version of the translator looked only at `contact.email` and
       `contact.fields.all.email`, recorded an empty address, and attribution
       survived only because the contact id happened to be present. A handover
       built from that row would have had no address for Sales to write to. */
    expect(events[0].email).toBe("chunk0.live@grav-integration-test.invalid");
    expect(events[0].externalContactId).toBe("1");
    expect(events[0].sourceEventId).toBe("mautic.email_on_open:stat:1");
    expect(events[0].kind).toBe("email_opened");
    expect(events[0].assetName).toBe("GRAV Chunk 0 probe");
  });

  test("there really is no flat email on the contact — the fixture is not a straw man", () => {
    const stat = fixture.payload["mautic.email_on_open"][0].stat;
    expect(stat.lead.email).toBeUndefined();
    expect(stat.lead.fields.all).toBeUndefined();
    expect(stat.lead.fields.core.email.value).toBe("chunk0.live@grav-integration-test.invalid");
    expect(stat.emailAddress).toBe("chunk0.live@grav-integration-test.invalid");
  });

  test("the email resolver checks every observed location in order", () => {
    const { contactEmailOf } = contract;
    expect(contactEmailOf({ email: "A@b.in" })).toBe("a@b.in");
    expect(contactEmailOf({ fields: { all: { email: "C@d.in" } } })).toBe("c@d.in");
    expect(contactEmailOf({ fields: { core: { email: { value: "E@f.in" } } } })).toBe("e@f.in");
    expect(contactEmailOf({ fields: { professional: { email: { normalizedValue: "g@h.in" } } } })).toBe("g@h.in");
    /* An event-specific fallback is used only when the contact carries none. */
    expect(contactEmailOf({ id: 9 }, "I@j.in")).toBe("i@j.in");
    expect(contactEmailOf({ email: "k@l.in" }, "ignored@m.in")).toBe("k@l.in");
    expect(contactEmailOf({})).toBe("");
  });

  test("the real payload records once and replays without duplicating", async () => {
    const { events } = contract.translate(fixture.payload);
    const first = await eventIntake.recordEvent({ companyId, event: events[0] });
    const second = await eventIntake.recordEvent({ companyId, event: events[0] });
    expect(first.recorded).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(1);
  });
});

describe("Replay creates no duplicate ledger row", () => {
  test("the same Mautic delivery, translated and recorded twice, is one row", async () => {
    const { events } = contract.translate(MAUTIC_PAYLOAD);

    const first = await Promise.all(events.map((e) => eventIntake.recordEvent({ companyId, event: e })));
    const second = await Promise.all(events.map((e) => eventIntake.recordEvent({ companyId, event: e })));

    /* Three events now: form submit, click, and the send. Asserted by length
       rather than a literal pair, so adding a supported event kind to the
       fixture does not silently make this test weaker. */
    expect(first).toHaveLength(3);
    expect(first.every((r) => r.recorded)).toBe(true);
    expect(second.every((r) => r.duplicate)).toBe(true);
    expect(await MarketingIntentEvent.countDocuments({})).toBe(3);
  });

  test("a ledger row keeps bounded, redacted evidence — never the provider's item", async () => {
    const form = contract.translate(MAUTIC_PAYLOAD).events.find((e) => e.kind === "form_submitted");
    await eventIntake.recordEvent({ companyId, event: form });
    const row = await MarketingIntentEvent.findOne({ sourceEventId: form.sourceEventId }).lean();

    /* ── UPDATED IN CHUNK 2 ────────────────────────────────────────────────
       This asserted `row.raw.submission.id`, i.e. that the provider's entire
       item was stored. A single Mautic open event is over eight kilobytes of
       contact-field descriptors; keeping it meant an unbounded copy of somebody's
       personal data in an immutable row that outlives their deletion. What is
       kept now is what an investigation needs. */
    expect(row.raw).toBeUndefined();
    expect(row.evidence.providerRecordType).toBe("submission");
    expect(row.evidence.providerRecordId).toBe("902");
    expect(row.evidence.providerEventType).toBe("mautic.form_on_submit");
    /* Field KEYS, never the person's answers. */
    expect(row.evidence.resultKeys).toEqual(expect.arrayContaining(["product_interest"]));
    expect(JSON.stringify(row.evidence)).not.toContain("housekeeping uniforms");

    expect(row.occurredAt.toISOString()).toBe("2026-09-09T08:00:00.000Z");
    expect(row.receivedAt).toBeInstanceOf(Date);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. SAFE LOGGING AND HEALTHY-PATH HEALTH
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Operational surface", () => {
  test("a healthy instance reports every check ok and a real segment count", async () => {
    const { client } = clientWith();
    const report = await health.check({ client, env: ENV });
    expect(report.healthy).toBe(true);
    expect(report.segmentCount).toBe(1);
    /* The database is inferred through Mautic, and the report says so rather
       than claiming a check that did not happen. */
    expect(report.checks.database.detail).toContain("Inferred");
  });

  test("the webhook state distinguishes 'configured' from 'proved by a delivery'", async () => {
    const before = await health.webhookState({ companyId, env: { MAUTIC_WEBHOOK_SECRET: SECRET, MARKETING_COMPANY_ID: "x" } });
    expect(before).toMatchObject({ secret: "configured", companyConfigured: true, lastEventAt: null, eventCount: 0 });

    const { events } = contract.translate(MAUTIC_PAYLOAD);
    await eventIntake.recordEvent({ companyId, event: events[0] });
    const after = await health.webhookState({ companyId, env: { MAUTIC_WEBHOOK_SECRET: SECRET } });
    expect(after.eventCount).toBe(1);
    expect(after.lastEventAt).not.toBeNull();
  });

  test("an unset webhook secret reads as missing, not as configured", async () => {
    expect((await health.webhookState({ env: {} })).secret).toBe("missing");
  });

  test("logging masks the person and never carries the query", () => {
    const { maskEmail, safeUrl } = require("../../services/marketing/mauticClient");
    expect(maskEmail("meera@aurorahotels.in")).toBe("m***@aurorahotels.in");
    expect(safeUrl("/api/contacts?where[0][val]=meera@aurorahotels.in")).toBe("/api/contacts");
  });
});
